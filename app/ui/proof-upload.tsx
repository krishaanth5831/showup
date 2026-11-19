"use client";

// Picks a workout screenshot, shrinks it in the browser (so uploads stay small and fast
// on mobile data) and sends it to the server, where Claude checks it.

import { Camera } from "@phosphor-icons/react";
import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { type FormState, uploadProofAction } from "@/app/actions";
import { Message } from "./forms";
import { buttonClass } from "./styles";

const MAX_SIDE = 1600;

async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.82));
    if (blob) return blob;
  } catch {
    // Some formats can't be decoded by every browser; the server will judge the original.
  }
  return file;
}

export function ProofUpload({ day, label, replace }: { day: string; label: string; replace: boolean }) {
  const action = useMemo(() => uploadProofAction.bind(null, day), [day]);
  const [state, run] = useActionState<FormState, FormData>(action, {});
  const [working, startTransition] = useTransition();
  const [localError, setLocalError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLocalError(null);
    const blob = await shrink(file);
    if (blob.size > 3_400_000) {
      setLocalError("That picture is too large. Take a screenshot instead of a photo.");
      return;
    }
    const form = new FormData();
    form.set("image", new File([blob], "proof.jpg", { type: blob.type || "image/jpeg" }));
    startTransition(() => run(form));
  }

  return (
    <div className="flex flex-col gap-2">
      <input ref={input} type="file" accept="image/*" className="sr-only" onChange={onPick} aria-label={label} />
      <div>
        <button type="button" disabled={working} onClick={() => input.current?.click()} className={buttonClass(replace ? "outline" : "solid")}>
          <Camera size={18} weight="bold" aria-hidden />
          {working ? "Checking the photo" : label}
        </button>
      </div>
      <Message state={localError ? { error: localError } : state} />
    </div>
  );
}
