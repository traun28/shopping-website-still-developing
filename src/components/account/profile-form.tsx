"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateProfileAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

export function ProfileForm({ defaultName, defaultPhone }: { defaultName: string; defaultPhone: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    const result = await updateProfileAction(prev, formData);
    if (result.ok) router.refresh();
    return result;
  }, initialState);

  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-5 rounded-card border-[1.5px] border-clay bg-cream p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-sm font-bold uppercase tracking-tight">Basic details</h2>
        {pending ? <span className="font-mono text-[10px] uppercase tracking-widest text-smoke">Saving…</span> : null}
      </div>

      {state.ok ? <Alert variant="success">{state.message}</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <Field label="Full name" required error={fields?.name}>
        <Input
          type="text"
          name="name"
          defaultValue={defaultName}
          autoComplete="name"
          invalid={Boolean(fields?.name)}
          disabled={pending}
        />
      </Field>

      <Field label="Phone" error={fields?.phone} description="Optional contact number. Saving it does not verify the number.">
        <Input
          type="tel"
          name="phone"
          defaultValue={defaultPhone}
          autoComplete="tel"
          placeholder="98765 43210"
          invalid={Boolean(fields?.phone)}
          disabled={pending}
        />
      </Field>

      <Button type="submit" variant="primary" size="md" loading={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
