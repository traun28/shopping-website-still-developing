"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { savePreferencesAction, type ActionResult } from "@/server/actions/account-actions";
import type { PreferencesDTO } from "@/services/preferences.service";
import { useState } from "react";

const initialState: ActionResult = { ok: false, error: "" };

const preferenceRows = [
  {
    key: "marketingEmails" as const,
    label: "Marketing emails",
    description: "Explicit opt-in for marketing email. Off by default; order updates are separate.",
  },
  {
    key: "orderNotifications" as const,
    label: "Order notifications",
    description: "Confirmations, production updates and delivery alerts. Recommended on.",
  },
  {
    key: "promotionalNotifications" as const,
    label: "Promotional notifications",
    description: "Optional promotional messages, separate from transactional order notices.",
  },
];

export function PreferencesForm({ initial }: { initial: PreferencesDTO }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    const result = await savePreferencesAction(prev, formData);
    if (result.ok) router.refresh();
    return result;
  }, initialState);

  return (
    <form action={formAction} className="space-y-5 rounded-card border-[1.5px] border-clay bg-cream p-6">
      <h2 className="font-display text-sm font-bold uppercase tracking-tight">Notifications & preferences</h2>

      {state.ok ? <Alert variant="success">{state.message}</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <div className="divide-y divide-clay/70">
        {preferenceRows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 py-4">
            <div>
              <p className="text-sm font-semibold">{row.label}</p>
              <p className="mt-0.5 text-xs text-smoke">{row.description}</p>
            </div>
            <input
              type="hidden"
              name={row.key}
              value={values[row.key] ? "true" : "false"}
            />
            <Switch
              checked={values[row.key]}
              onCheckedChange={(checked) => setValues((v) => ({ ...v, [row.key]: Boolean(checked) }))}
              disabled={pending}
              aria-label={row.label}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div>
          <p id="language-label" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">
            Language
          </p>
          <input type="hidden" name="language" value={values.language} />
          <Select
            value={values.language}
            onValueChange={(value) => setValues((v) => ({ ...v, language: value as PreferencesDTO["language"] }))}
            disabled={pending}
          >
            <SelectTrigger aria-labelledby="language-label" className="mt-2 h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en-IN">English (India)</SelectItem>
              <SelectItem value="hi-IN">हिन्दी (Hindi)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">Currency</p>
          <input type="hidden" name="currency" value="INR" />
          <div className="mt-2 flex h-11 items-center rounded-pill border-[1.5px] border-clay bg-sand/40 px-5 text-sm text-smoke">
            INR (₹) — current storefront currency
          </div>
        </div>
        <div>
          <p id="measurement-label" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">
            Measurement system
          </p>
          <input type="hidden" name="measurementSystem" value={values.measurementSystem} />
          <Select
            value={values.measurementSystem}
            onValueChange={(value) => setValues((v) => ({ ...v, measurementSystem: value as PreferencesDTO["measurementSystem"] }))}
            disabled={pending}
          >
            <SelectTrigger aria-labelledby="measurement-label" className="mt-2 h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="METRIC">Metric (cm, kg)</SelectItem>
              <SelectItem value="IMPERIAL">Imperial (in, lb)</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-smoke">Saved for product measurements when they are displayed.</p>
        </div>
      </div>

      <Button type="submit" variant="primary" size="md" loading={pending}>
        {pending ? "Saving…" : "Save preferences"}
      </Button>
    </form>
  );
}
