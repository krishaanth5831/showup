// bunq bank API client: connect with an API key, list accounts, send a payment, read payments.
//
// How bunq's handshake works (done once, in bunqConnect):
//   1. installation   - we hand bunq a public key; every later request body is signed with the private half
//   2. device-server  - ties the API key to this "device"
//   3. session-server - gives a session token, valid for about a week, renewed here when it runs out
//
// API keys that start with "sandbox_" talk to bunq's test environment (fake money).

import crypto from "node:crypto";
import type { Db } from "./db";
import { bankAmount, centsFromBank, normalizeIban } from "./engine";
import { type FetchLike, httpFetch } from "./http";
import { secretGet, secretSet } from "./kv";
import { BankError, type BankPayment, type BankPort, type PayRequest } from "./ports";

export interface BunqState {
  apiKey: string;
  env: "sandbox" | "production";
  privateKeyPem: string;
  installationToken: string;
  sessionToken: string;
  userId: number;
  userName: string;
  accountId: number | null;
  accountIban: string;
  accountName: string;
  accountLabel: string;
  connectedAt: string;
}

export interface BunqAccount {
  id: number;
  label: string;
  iban: string;
  name: string;
  balanceCents: number;
  kind: string;
}

const HOSTS = {
  sandbox: "https://public-api.sandbox.bunq.com/v1",
  production: "https://api.bunq.com/v1",
};

export function bunqEnvOf(apiKey: string): "sandbox" | "production" {
  return apiKey.startsWith("sandbox_") ? "sandbox" : "production";
}

interface BunqEnvelope {
  Response?: Record<string, unknown>[];
  Error?: { error_description?: string; error_description_translated?: string }[];
  Pagination?: { older_url?: string | null; newer_url?: string | null; future_url?: string | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function plainAuthHelp(env: string): string {
  return env === "production"
    ? "bunq refused the API key. Check that the key is still active and that \"Allow all IP addresses\" is switched on for it in the bunq app, then connect again."
    : "The bunq sandbox refused the API key. Create a new sandbox key and connect again.";
}

async function call(
  fetchImpl: FetchLike,
  env: "sandbox" | "production",
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; token?: string; privateKeyPem?: string } = {},
): Promise<BunqEnvelope> {
  const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "User-Agent": "showup/1.0",
    "X-Bunq-Client-Request-Id": crypto.randomUUID(),
    "X-Bunq-Geolocation": "0 0 0 0 000",
    "X-Bunq-Language": "en_US",
    "X-Bunq-Region": "nl_NL",
  };
  if (opts.token) headers["X-Bunq-Client-Authentication"] = opts.token;
  if (opts.privateKeyPem && text) {
    headers["X-Bunq-Client-Signature"] = crypto.sign("sha256", Buffer.from(text), opts.privateKeyPem).toString("base64");
  }
  const url = path.startsWith("http") ? path : HOSTS[env] + path.replace(/^\/v1/, "");

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body: method === "GET" ? undefined : text });
    } catch (e) {
      // No answer at all: for a payment this means "we don't know if it went out".
      throw new BankError(`No answer from bunq (${(e as Error).message}).`, false, "unknown");
    }
    const raw = await res.text().catch(() => "");
    let json: BunqEnvelope = {};
    try {
      json = raw ? (JSON.parse(raw) as BunqEnvelope) : {};
    } catch {
      /* non-JSON error page */
    }
    if (res.ok) return json;

    const said = json.Error?.map((e) => e.error_description).filter(Boolean).join(" ") || `HTTP ${res.status}`;
    if (res.status === 429 && attempt < 3) {
      await sleep(3200 * (attempt + 1)); // rate limited: nothing was executed, so waiting and retrying is safe
      continue;
    }
    if (res.status === 429) throw new BankError(`bunq is rate limiting: ${said}`, true, "rate");
    if (res.status >= 500) throw new BankError(`bunq had a server problem: ${said}`, false, "unknown");
    if (res.status === 401 || res.status === 403) throw new BankError(said, true, "auth");
    if (/enough money|insufficient/i.test(said)) throw new BankError("Not enough money in the bunq account.", true, "funds");
    throw new BankError(`bunq said no: ${said}`, true, "rejected");
  }
}

function pick<T>(env: BunqEnvelope, key: string): T | undefined {
  return env.Response?.find((x) => key in x)?.[key] as T | undefined;
}

async function openSession(
  fetchImpl: FetchLike,
  s: Pick<BunqState, "apiKey" | "env" | "privateKeyPem" | "installationToken">,
): Promise<{ sessionToken: string; userId: number; userName: string }> {
  const res = await call(fetchImpl, s.env, "POST", "/session-server", {
    body: { secret: s.apiKey },
    token: s.installationToken,
    privateKeyPem: s.privateKeyPem,
  });
  const token = pick<{ token: string }>(res, "Token")?.token;
  const user =
    pick<{ id: number; display_name?: string }>(res, "UserPerson") ??
    pick<{ id: number; display_name?: string }>(res, "UserCompany") ??
    pick<{ id: number; display_name?: string }>(res, "UserApiKey");
  if (!token || !user) throw new BankError("bunq did not return a session.", true, "auth");
  return { sessionToken: token, userId: user.id, userName: user.display_name ?? "" };
}

/** First-time handshake with a freshly pasted API key. */
export async function bunqConnect(apiKeyRaw: string, fetchImpl: FetchLike = httpFetch): Promise<BunqState> {
  const apiKey = apiKeyRaw.trim();
  if (apiKey.length < 20) throw new BankError("That doesn't look like a bunq API key.", true, "auth");
  const env = bunqEnvOf(apiKey);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  try {
    const inst = await call(fetchImpl, env, "POST", "/installation", { body: { client_public_key: publicKey } });
    const installationToken = pick<{ token: string }>(inst, "Token")?.token;
    if (!installationToken) throw new BankError("bunq did not return an installation token.", true, "auth");
    await call(fetchImpl, env, "POST", "/device-server", {
      // "*" = usable from any IP address. Needed on serverless hosting, where the address changes.
      body: { description: "Showup", secret: apiKey, permitted_ips: ["*"] },
      token: installationToken,
      privateKeyPem: privateKey,
    });
    const base = { apiKey, env, privateKeyPem: privateKey, installationToken };
    const session = await openSession(fetchImpl, base);
    return {
      ...base,
      ...session,
      accountId: null,
      accountIban: "",
      accountName: "",
      accountLabel: "",
      connectedAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e instanceof BankError && (e.kind === "auth" || e.kind === "rejected")) {
      throw new BankError(`${plainAuthHelp(env)} (bunq: ${e.message})`, true, "auth");
    }
    throw e;
  }
}

interface RawAlias {
  type: string;
  value: string;
  name: string;
}
interface RawAccount {
  id: number;
  description: string;
  status: string;
  balance?: { value: string };
  alias?: RawAlias[];
}
interface RawPayment {
  id: number;
  created: string;
  amount: { value: string };
  description?: string;
  counterparty_alias?: { iban?: string | null; display_name?: string | null };
}

/** bunq timestamps are UTC, written as "2026-11-19 10:35:27.219170". */
export function parseBunqTime(s: string): Date {
  return new Date(`${s.slice(0, 23).replace(" ", "T")}Z`);
}

export class BunqClient {
  constructor(
    private state: BunqState,
    private persist: (s: BunqState) => Promise<void> = async () => {},
    private fetchImpl: FetchLike = httpFetch,
  ) {}

  get current(): BunqState {
    return this.state;
  }

  /** An authenticated request. If the session has run out it is renewed once and the request repeated. */
  private async authed(method: "GET" | "POST", path: string, body?: unknown): Promise<BunqEnvelope> {
    const go = () =>
      call(this.fetchImpl, this.state.env, method, path, {
        body,
        token: this.state.sessionToken,
        privateKeyPem: this.state.privateKeyPem,
      });
    try {
      return await go();
    } catch (e) {
      if (!(e instanceof BankError) || e.kind !== "auth") throw e;
      // A refused request was not executed, so renewing the session and repeating it can't double anything.
      let session;
      try {
        session = await openSession(this.fetchImpl, this.state);
      } catch (inner) {
        if (inner instanceof BankError && inner.definite) {
          throw new BankError(`${plainAuthHelp(this.state.env)} (bunq: ${inner.message})`, true, "auth");
        }
        throw inner;
      }
      this.state = { ...this.state, ...session };
      await this.persist(this.state);
      return go();
    }
  }

  async listAccounts(): Promise<BunqAccount[]> {
    const res = await this.authed("GET", `/user/${this.state.userId}/monetary-account?count=200`);
    const out: BunqAccount[] = [];
    for (const item of res.Response ?? []) {
      const kind = Object.keys(item)[0];
      const a = item[kind] as RawAccount;
      const iban = a.alias?.find((x) => x.type === "IBAN");
      if (!a || a.status !== "ACTIVE" || !iban) continue;
      out.push({
        id: a.id,
        label: a.description || "Account",
        iban: normalizeIban(iban.value),
        name: iban.name,
        balanceCents: centsFromBank(a.balance?.value ?? "0"),
        kind,
      });
    }
    // Plain current accounts first: those are the ones payments normally leave from.
    return out.sort((x, y) => Number(y.kind === "MonetaryAccountBank") - Number(x.kind === "MonetaryAccountBank"));
  }

  private accountPath(): string {
    if (!this.state.accountId) throw new BankError("No bunq account chosen yet.", true, "rejected");
    return `/user/${this.state.userId}/monetary-account/${this.state.accountId}`;
  }

  async pay(req: PayRequest): Promise<{ id: string }> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new BankError("Invalid amount.", true, "rejected");
    const res = await this.authed("POST", `${this.accountPath()}/payment`, {
      amount: { value: bankAmount(req.amountCents), currency: "EUR" },
      counterparty_alias: { type: "IBAN", value: normalizeIban(req.iban), name: req.name },
      description: req.description.slice(0, 140),
    });
    const id = pick<{ id: number }>(res, "Id")?.id;
    // A success answer without an id should never happen; treat it as "unknown" so it gets looked up.
    if (!id) throw new BankError("bunq accepted the payment but returned no id.", false, "unknown");
    return { id: String(id) };
  }

  async listPayments(sinceId?: string | null): Promise<BankPayment[]> {
    const out: BankPayment[] = [];
    const stopAt = sinceId ? Number(sinceId) : null;
    let path: string | null = `${this.accountPath()}/payment?count=200`;
    for (let page = 0; path && page < 10; page++) {
      const res: BunqEnvelope = await this.authed("GET", path);
      const items = (res.Response ?? []).map((x) => x.Payment as RawPayment).filter(Boolean);
      for (const p of items) {
        out.push({
          id: String(p.id),
          created: parseBunqTime(p.created),
          amountCents: centsFromBank(p.amount.value),
          counterpartyIban: normalizeIban(p.counterparty_alias?.iban ?? ""),
          counterpartyName: p.counterparty_alias?.display_name ?? "",
          description: p.description ?? "",
        });
      }
      const oldest = items.length ? Math.min(...items.map((p) => p.id)) : 0;
      const reachedKnown = stopAt === null || oldest <= stopAt || items.length === 0;
      path = reachedKnown ? null : (res.Pagination?.older_url ?? null);
    }
    return out.sort((a, b) => Number(b.id) - Number(a.id));
  }

  /** Test environment only: asks bunq's sandbox "sugar daddy" for play money (max €500 per request). */
  async sandboxTopUp(cents: number): Promise<void> {
    if (this.state.env !== "sandbox") throw new BankError("Top-ups only exist in the sandbox.", true, "rejected");
    await this.authed("POST", `${this.accountPath()}/request-inquiry`, {
      amount_inquired: { value: bankAmount(cents), currency: "EUR" },
      counterparty_alias: { type: "EMAIL", value: "sugardaddy@bunq.com", name: "Sugar Daddy" },
      description: "sandbox top-up",
      allow_bunqme: false,
    });
  }

  /** Points the client at one of the user's accounts. */
  useAccount(a: BunqAccount): BunqState {
    this.state = { ...this.state, accountId: a.id, accountIban: a.iban, accountName: a.name, accountLabel: a.label };
    return this.state;
  }

  async balanceCents(): Promise<number> {
    const res = await this.authed("GET", this.accountPath());
    const item = res.Response?.[0];
    const a = item ? (Object.values(item)[0] as RawAccount) : undefined;
    return centsFromBank(a?.balance?.value ?? "0");
  }
}

// ---- stored connection ----

const KEY = "bunq";

export async function loadBunq(db: Db): Promise<BunqState | null> {
  return secretGet<BunqState>(db, KEY);
}

export async function saveBunq(db: Db, state: BunqState): Promise<void> {
  await secretSet(db, KEY, state);
}

export async function bunqClient(db: Db, fetchImpl: FetchLike = httpFetch): Promise<BunqClient | null> {
  const state = await loadBunq(db);
  return state ? new BunqClient(state, (s) => saveBunq(db, s), fetchImpl) : null;
}

/** The bank as the rest of the app sees it. */
export class BunqBank implements BankPort {
  private client: BunqClient | null | undefined;
  constructor(
    private db: Db,
    private fetchImpl: FetchLike = httpFetch,
  ) {}

  private async get(): Promise<BunqClient | null> {
    if (this.client === undefined) this.client = await bunqClient(this.db, this.fetchImpl);
    return this.client;
  }

  async connected(): Promise<boolean> {
    const c = await this.get();
    return !!c && !!c.current.accountId;
  }

  async pay(req: PayRequest): Promise<{ id: string }> {
    const c = await this.get();
    if (!c) throw new BankError("bunq is not connected.", true, "auth");
    return c.pay(req);
  }

  async listPayments(sinceId?: string | null): Promise<BankPayment[]> {
    const c = await this.get();
    if (!c) throw new BankError("bunq is not connected.", true, "auth");
    return c.listPayments(sinceId);
  }
}
