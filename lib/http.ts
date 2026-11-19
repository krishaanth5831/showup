// fetch with a timeout. When the machine sits behind an HTTP proxy (HTTPS_PROXY set, as in
// some development sandboxes) requests are routed through it; Node's fetch ignores it otherwise.

let dispatcherReady: Promise<unknown> | null = null;

async function proxyDispatcher(): Promise<unknown> {
  if (!(process.env.HTTPS_PROXY || process.env.https_proxy)) return undefined;
  if (!dispatcherReady) {
    dispatcherReady = import("undici").then((u) => new u.EnvHttpProxyAgent()).catch(() => undefined);
  }
  return dispatcherReady;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const httpFetch: FetchLike = async (url, init = {}) => {
  const dispatcher = await proxyDispatcher();
  const signal = init.signal ?? AbortSignal.timeout(20_000);
  if (dispatcher) {
    const { fetch: undiciFetch } = await import("undici");
    // undici's fetch is the same API; it is used here only because it accepts the proxy dispatcher.
    return (undiciFetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, {
      ...init,
      signal,
      dispatcher,
    });
  }
  return fetch(url, { ...init, signal });
};
