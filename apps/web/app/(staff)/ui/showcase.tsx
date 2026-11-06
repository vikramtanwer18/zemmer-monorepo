"use client";

import {
  ActionForm,
  Alert,
  AppShell,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardDescription,
  CardTitle,
  CheckboxField,
  ColumnVisibility,
  Combobox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  LinkButton,
  MobileTabBar,
  PageHeader,
  Pagination,
  RadioGroup,
  SelectField,
  Skeleton,
  StatCard,
  SubmitButton,
  Switch,
  Tabs,
  TextareaField,
  ToastProvider,
  useToast,
  type FormActionResult,
} from "@gym/ui";
import { Bell, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

const BRANCHES = [
  { id: "1", name: "C-Scheme", city: "Jaipur", members: 412, status: "Active" },
  {
    id: "2",
    name: "Malviya Nagar",
    city: "Jaipur",
    members: 238,
    status: "Active",
  },
  {
    id: "3",
    name: "Vaishali Nagar",
    city: "Jaipur",
    members: 0,
    status: "Archived",
  },
];
const COLUMNS = [
  {
    key: "name",
    header: "Branch",
    cell: (b: (typeof BRANCHES)[number]) => b.name,
    sortable: true,
  },
  {
    key: "city",
    header: "City",
    cell: (b: (typeof BRANCHES)[number]) => b.city,
  },
  {
    key: "members",
    header: "Members",
    cell: (b: (typeof BRANCHES)[number]) => b.members,
    sortable: true,
  },
  {
    key: "status",
    header: "Status",
    cell: (b: (typeof BRANCHES)[number]) => (
      <Badge tone={b.status === "Active" ? "success" : "neutral"}>
        {b.status}
      </Badge>
    ),
  },
];

/** Fake action: fails when the name is "error" so both states can be seen. */
async function demoAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  await new Promise((r) => setTimeout(r, 400));
  const name = String(form.get("name") ?? "");
  if (!name) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Please check the highlighted fields.",
        fields: { name: ["Enter a name."] },
      },
    };
  }
  if (name === "error")
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Something went wrong. Please try again.",
      },
    };
  return { ok: true, message: `Saved ${name}.` };
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 border-b border-border pb-10"
    >
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast("Member saved.")}>
        Success toast
      </Button>
      <Button
        variant="outline"
        onClick={() => toast("Payment failed. Try again.", "danger")}
      >
        Error toast
      </Button>
      <Button
        variant="outline"
        onClick={() => toast("Sync runs every 15 minutes.", "info")}
      >
        Info toast
      </Button>
    </div>
  );
}

export function Showcase() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <ToastProvider>
      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8">
        <PageHeader
          title="Design system"
          description="Every @gym/ui component in each state. Development only."
        />

        <Section id="buttons" title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="accent">Accent</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <LinkButton href="#buttons" variant="outline">
              Link button
            </LinkButton>
            <IconButton icon={Pencil} label="Edit" />
            <IconButton icon={Trash2} label="Delete" variant="outline" />
            <IconButton icon={Bell} label="Notifications" variant="primary" />
          </div>
        </Section>

        <Section id="badges" title="Badges and alerts">
          <div className="flex flex-wrap gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="success">Active</Badge>
            <Badge tone="warning">Expiring</Badge>
            <Badge tone="danger">Overdue</Badge>
            <Badge tone="info">Trial</Badge>
          </div>
          <Alert tone="info">Your free trial ends in 14 days.</Alert>
          <Alert tone="success">Saved.</Alert>
          <Alert tone="warning" title="Read-only">
            Your subscription is not active.
          </Alert>
          <Alert tone="danger">The payment could not be recorded.</Alert>
        </Section>

        <Section id="forms" title="Form controls">
          <ActionForm
            action={demoAction}
            className="grid max-w-2xl gap-4"
            successMessage="Saved."
          >
            <FormField
              label="Name"
              name="name"
              hint='Type "error" to see a server error; leave empty for a field error.'
            />
            <FormField
              label="Disabled field"
              name="disabled"
              disabled
              defaultValue="Can't change this"
            />
            <FormField
              label="Field with error"
              name="bad"
              error="This email is already used."
              defaultValue="a@b"
            />
            <TextareaField label="Notes" name="notes" />
            <SelectField
              label="Plan"
              name="plan"
              placeholder="Choose a plan"
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "quarterly", label: "Quarterly" },
              ]}
            />
            <Combobox
              label="State"
              name="state"
              options={[
                { value: "08", label: "Rajasthan" },
                { value: "27", label: "Maharashtra" },
                { value: "29", label: "Karnataka" },
                { value: "07", label: "Delhi" },
              ]}
            />
            <CheckboxField
              name="terms"
              label="Send a receipt by email"
              hint="Uses the member's saved email."
            />
            <Switch
              name="autoRenew"
              label="Auto-renew"
              hint="Renews on the last day of the membership."
            />
            <Switch label="Disabled switch" disabled defaultChecked />
            <RadioGroup
              legend="Billing cycle"
              name="cycle"
              defaultValue="monthly"
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: "Yearly", hint: "Two months free" },
              ]}
            />
            <div>
              <SubmitButton>Submit</SubmitButton>
            </div>
          </ActionForm>
        </Section>

        <Section id="overlays" title="Dialogs, drawer, menu, toast">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
            <Button variant="outline" onClick={() => setDrawerOpen(true)}>
              Open drawer
            </Button>
            <ConfirmDialog
              trigger="Confirm dialog"
              title="Archive this branch?"
              description="Nothing is deleted."
              confirmLabel="Archive"
              formAction={async () => {
                await new Promise((r) => setTimeout(r, 300));
              }}
            />
            <DropdownMenu
              label="More actions"
              items={[
                { label: "Edit branch", href: "#overlays" },
                { label: "Duplicate", onSelect: () => {} },
                { label: "Archive", onSelect: () => {}, danger: true },
              ]}
            />
          </div>
          <ToastDemo />
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Freeze membership"
            description="The end date moves by the frozen days."
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setDialogOpen(false)}>Freeze</Button>
              </>
            }
          >
            <FormField
              label="Days"
              name="days"
              type="number"
              defaultValue={7}
            />
          </Dialog>
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title="Filters"
          >
            <SelectField
              label="Status"
              name="status"
              options={[
                { value: "active", label: "Active" },
                { value: "expired", label: "Expired" },
              ]}
            />
          </Drawer>
        </Section>

        <Section id="navigation" title="Navigation">
          <Breadcrumbs
            items={[
              { label: "Branches", href: "#navigation" },
              { label: "C-Scheme" },
            ]}
          />
          <Tabs
            label="Example tabs"
            current="#overview"
            items={[
              { href: "#overview", label: "Overview" },
              { href: "#members", label: "Members" },
              { href: "#billing", label: "Billing" },
            ]}
          />
          <Pagination
            page={2}
            pageSize={20}
            total={95}
            hrefFor={(p) => `#page-${p}`}
          />
        </Section>

        <Section id="data" title="Data display">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Active members" value="650" hint="+12 this week" />
            <StatCard label="Expiring in 7 days" value="18" tone="warning" />
            <StatCard label="Overdue" value="₹42,300" tone="danger" />
            <StatCard label="Collected today" value="₹18,900" tone="success" />
          </div>
          <Card>
            <CardTitle>Card</CardTitle>
            <CardDescription>Groups related content.</CardDescription>
          </Card>
          <ColumnVisibility
            columns={COLUMNS.map(({ key, header }) => ({ key, header }))}
          >
            <DataTable
              caption="Branches (sortable)"
              columns={COLUMNS}
              rows={BRANCHES}
              rowKey={(b) => b.id}
              sort={{ key: "name", dir: "asc" }}
              sortHref={(s) => `#sort-${s.key}-${s.dir}`}
            />
          </ColumnVisibility>
          <h3 className="font-medium">Loading</h3>
          <DataTable
            caption="Loading table"
            columns={COLUMNS}
            rows={[]}
            rowKey={(b) => b.id}
            loading
          />
          <h3 className="font-medium">Empty</h3>
          <DataTable
            caption="Empty table"
            columns={COLUMNS}
            rows={[]}
            rowKey={(b) => b.id}
            empty={
              <EmptyState
                title="No branches yet"
                description="Add your first branch."
              />
            }
          />
          <h3 className="font-medium">Error</h3>
          <ErrorState
            title="Couldn't load branches"
            action={
              <Button variant="outline" size="sm">
                Try again
              </Button>
            }
          />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </Section>

        <Section id="shells" title="App shell and member tab bar">
          <div className="h-96 overflow-hidden rounded-lg border border-border [transform:translateZ(0)]">
            <AppShell
              brand="Gym SaaS"
              subtitle="Iron Temple Jaipur"
              currentPath="/"
              embedded
              nav={[
                { href: "/", label: "Dashboard", icon: "dashboard" },
                { href: "/branches", label: "Branches", icon: "branches" },
                { href: "/staff", label: "Staff", icon: "staff" },
              ]}
              headerStart={
                <span className="text-sm font-semibold">
                  Iron Temple Jaipur
                </span>
              }
              headerEnd={
                <IconButton icon={Bell} label="Notifications (preview)" />
              }
            >
              <p className="text-sm text-muted">Page content goes here.</p>
            </AppShell>
          </div>
          <div className="relative h-28 overflow-hidden rounded-lg border border-border [transform:translateZ(0)]">
            <MobileTabBar
              currentPath="/m/"
              items={[
                { href: "/m/", label: "Home", icon: "home" },
                { href: "/m/card", label: "Card", icon: "card" },
                { href: "/m/classes", label: "Classes", icon: "classes" },
                { href: "/m/pay", label: "Pay", icon: "payments" },
                { href: "/m/me", label: "Profile", icon: "profile" },
              ]}
            />
          </div>
        </Section>
      </main>
    </ToastProvider>
  );
}
