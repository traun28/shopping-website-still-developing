"use client";

import { Home, MapPin, Pencil, Phone, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AddressForm } from "@/components/account/address-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { notify } from "@/lib/toast";
import {
  deleteAddressAction,
  setDefaultAddressAction,
  setDefaultBillingAddressAction,
} from "@/server/actions/account-actions";
import { cn } from "@/lib/utils";
import type { Address } from "@/db/schema";

/**
 * Address book — card grid with add/edit modal forms, default switching
 * (transactional server-side) and confirmed deletion.
 */
export function AddressBook({ initialAddresses }: { initialAddresses: Address[] }) {
  const router = useRouter();
  const [addresses, setAddresses] = useState(initialAddresses);
  const [syncedAddresses, setSyncedAddresses] = useState(initialAddresses);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Address | null>(null);

  // Server refetches deliver fresh rows via props after router.refresh().
  if (syncedAddresses !== initialAddresses) {
    setSyncedAddresses(initialAddresses);
    setAddresses(initialAddresses);
  }

  async function handleDelete(id: string) {
    const target = addresses.find((row) => row.id === id);
    const result = await deleteAddressAction(id, target?.version);
    if (result.ok) {
      setAddresses((rows) => rows.filter((row) => row.id !== id));
      router.refresh();
      notify.success("Address removed");
    } else {
      notify.error(result.error);
    }
  }

  async function handleSetDefault(id: string) {
    const result = await setDefaultAddressAction(id);
    if (result.ok) {
      setAddresses((rows) => rows.map((row) => ({ ...row, isDefault: row.id === id })));
      router.refresh();
      notify.success("Default shipping address updated");
    } else {
      notify.error(result.error);
    }
  }

  async function handleSetDefaultBilling(id: string) {
    const result = await setDefaultBillingAddressAction(id);
    if (result.ok) {
      setAddresses((rows) => rows.map((row) => ({ ...row, isDefaultBilling: row.id === id })));
      router.refresh();
      notify.success("Default billing address updated");
    } else {
      notify.error(result.error);
    }
  }

  if (addresses.length === 0) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={MapPin}
          title="No addresses saved"
          description="Save shipping and billing addresses to reuse them at checkout."
        />
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button variant="primary" size="lg">
              <Plus className="size-4" aria-hidden /> Add your first address
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Add address</DialogTitle>
            <AddressForm onDone={() => setAddOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
          {addresses.length} saved {addresses.length === 1 ? "address" : "addresses"}
        </p>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> Add address
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogTitle>Add address</DialogTitle>
            <AddressForm onDone={() => setAddOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {addresses.map((address) => (
          <article
            key={address.id}
            className={cn(
              "flex flex-col gap-4 rounded-card border-[1.5px] bg-cream p-5 transition-colors",
              address.isDefault || address.isDefaultBilling ? "border-flame" : "border-clay",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-pill border-[1.5px] border-ink" aria-hidden>
                  <Home className="size-3.5" />
                </span>
                <div>
                  <p className="font-display text-sm font-bold uppercase tracking-tight">{address.fullName}</p>
                  <p className="flex items-center gap-1 text-xs text-smoke">
                    <Phone className="size-3" aria-hidden /> {address.phone}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                {address.isDefault ? <Badge variant="new">Default shipping</Badge> : null}
                {address.isDefaultBilling ? <Badge variant="outline">Default billing</Badge> : null}
              </div>
            </div>

            <address className="text-sm not-italic leading-relaxed text-ink/80">
              {address.addressLine1}
              {address.addressLine2 ? `, ${address.addressLine2}` : ""}
              {address.locality ? `, ${address.locality}` : ""}
              <br />
              {address.landmark ? (
                <>
                  Near {address.landmark}
                  <br />
                </>
              ) : null}
              {address.city}{address.state ? `, ${address.state}` : ""}{address.postalCode ? ` ${address.postalCode}` : ""}
              <br />
              {address.country}
            </address>

            <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-clay pt-3">
              <Dialog open={editing?.id === address.id} onOpenChange={(open) => setEditing(open ? address : null)}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Pencil className="size-3.5" aria-hidden /> Edit
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[85vh] overflow-y-auto">
                  <DialogTitle>Edit address</DialogTitle>
                  <AddressForm
                    address={address}
                    onDone={() => {
                      setEditing(null);
                    }}
                  />
                </DialogContent>
              </Dialog>

              {address.isDefault ? null : (
                <Button variant="ghost" size="sm" onClick={() => handleSetDefault(address.id)}>
                  <Star className="size-3.5" aria-hidden /> Default shipping
                </Button>
              )}
              {address.isDefaultBilling ? null : (
                <Button variant="ghost" size="sm" onClick={() => handleSetDefaultBilling(address.id)}>
                  <Star className="size-3.5" aria-hidden /> Default billing
                </Button>
              )}

              <ConfirmDialog
                title="Delete this address?"
                description={`${address.addressLine1}, ${address.city} will be permanently removed from your account.`}
                confirmLabel="Delete"
                confirmVariant="danger"
                onConfirm={() => handleDelete(address.id)}
                trigger={
                  <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10">
                    <Trash2 className="size-3.5" aria-hidden /> Delete
                  </Button>
                }
              />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
