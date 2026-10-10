"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createAddressAction,
  updateAddressAction,
  type ActionResult,
} from "@/server/actions/account-actions";
import { INDIAN_STATES } from "@/validations/account";
import type { Address } from "@/db/schema";

const initialState: ActionResult = { ok: false, error: "" };

/** Used for both create and edit — one country-aware field contract. */
export function AddressForm({
  address,
  onDone,
}: {
  address?: Address;
  onDone: () => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(address);
  const [country, setCountry] = useState((address?.country ?? "IN").toUpperCase());
  const [addressType, setAddressType] = useState<"HOME" | "WORK" | "OTHER">(address?.addressType ?? "HOME");

  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    if (isEdit && address) return updateAddressAction(address.id, prev, formData);
    return createAddressAction(prev, formData);
  }, initialState);

  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
    onDone();
  }, [state.ok, router, onDone]);

  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4">
      {address ? <input type="hidden" name="expectedVersion" value={address.version} /> : null}
      {!state.ok && state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <input type="hidden" name="addressType" value={addressType} />
      <Field label="Address label" required>
        <Select value={addressType} onValueChange={(value) => setAddressType(value as typeof addressType)} disabled={pending}>
          <SelectTrigger aria-label="Address label" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="HOME">Home</SelectItem>
            <SelectItem value="WORK">Work</SelectItem>
            <SelectItem value="OTHER">Other</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Full name" required error={fields?.fullName}>
        <Input
          name="fullName"
          defaultValue={address?.fullName}
          autoComplete="name"
          placeholder="Recipient's full name"
          invalid={Boolean(fields?.fullName)}
          disabled={pending}
        />
      </Field>

      <Field label="Phone" required error={fields?.phone} description="Use an international prefix when needed, for example +1 or +91.">
        <Input
          name="phone"
          type="tel"
          defaultValue={address?.phone}
          autoComplete="tel"
          placeholder="+91 98765 43210"
          invalid={Boolean(fields?.phone)}
          disabled={pending}
        />
      </Field>

      <Field label="Address line 1" required error={fields?.addressLine1}>
        <Input
          name="addressLine1"
          defaultValue={address?.addressLine1}
          autoComplete="address-line1"
          placeholder="House or building, street"
          invalid={Boolean(fields?.addressLine1)}
          disabled={pending}
        />
      </Field>

      <Field label="Address line 2" error={fields?.addressLine2}>
        <Input
          name="addressLine2"
          defaultValue={address?.addressLine2 ?? ""}
          autoComplete="address-line2"
          placeholder="Apartment, suite, floor (optional)"
          invalid={Boolean(fields?.addressLine2)}
          disabled={pending}
        />
      </Field>

      <Field label="District / locality" error={fields?.locality}>
        <Input
          name="locality"
          defaultValue={address?.locality ?? ""}
          autoComplete="address-level3"
          placeholder="Area, district (optional)"
          invalid={Boolean(fields?.locality)}
          disabled={pending}
        />
      </Field>

      <Field label="Landmark" error={fields?.landmark}>
        <Input
          name="landmark"
          defaultValue={address?.landmark ?? ""}
          placeholder="Near… (optional)"
          invalid={Boolean(fields?.landmark)}
          disabled={pending}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="City / town" required error={fields?.city}>
          <Input
            name="city"
            defaultValue={address?.city}
            autoComplete="address-level2"
            placeholder="Bengaluru"
            invalid={Boolean(fields?.city)}
            disabled={pending}
          />
        </Field>
        <div>
          <Field label="State / region" required={country === "IN"} error={fields?.state}>
            <Input
              name="state"
              list={country === "IN" ? "india-address-states" : undefined}
              defaultValue={address?.state ?? ""}
              autoComplete="address-level1"
              placeholder={country === "IN" ? "Karnataka" : "State, province, region (if applicable)"}
              invalid={Boolean(fields?.state)}
              disabled={pending}
            />
          </Field>
          {country === "IN" ? (
            <datalist id="india-address-states">
              {INDIAN_STATES.map((region) => <option key={region} value={region} />)}
            </datalist>
          ) : null}
        </div>
        <Field label={country === "IN" ? "PIN code" : country === "US" ? "ZIP code" : "Postal code"} required={country === "IN"} error={fields?.postalCode}>
          <Input
            name="postalCode"
            inputMode={country === "IN" ? "numeric" : "text"}
            maxLength={20}
            defaultValue={address?.postalCode ?? ""}
            autoComplete="postal-code"
            placeholder={country === "IN" ? "560001" : "Postal code (if used in your country)"}
            invalid={Boolean(fields?.postalCode)}
            disabled={pending}
          />
        </Field>
        <Field label="Country code" required error={fields?.country} description="Two-letter ISO code, for example IN, US or GB.">
          <Input
            name="country"
            value={country}
            onChange={(event) => setCountry(event.target.value.toUpperCase().slice(0, 2))}
            autoComplete="country"
            maxLength={2}
            placeholder="IN"
            invalid={Boolean(fields?.country)}
            disabled={pending}
          />
        </Field>
      </div>

      <Field label="Delivery instructions" error={fields?.deliveryInstructions}>
        <Input
          name="deliveryInstructions"
          defaultValue={address?.deliveryInstructions ?? ""}
          placeholder="Gate code or safe drop-off note (optional)"
          invalid={Boolean(fields?.deliveryInstructions)}
          disabled={pending}
        />
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink/80">
        <Checkbox name="isDefaultShipping" defaultChecked={address?.isDefault ?? false} disabled={pending} />
        <span>Set as default shipping address</span>
      </label>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink/80">
        <Checkbox name="isDefaultBilling" defaultChecked={address?.isDefaultBilling ?? false} disabled={pending} />
        <span>Set as default billing address</span>
      </label>

      <div className="flex flex-wrap gap-3 pt-2">
        <Button type="submit" variant="primary" size="md" loading={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Save address"}
        </Button>
        <Button type="button" variant="outline" size="md" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
