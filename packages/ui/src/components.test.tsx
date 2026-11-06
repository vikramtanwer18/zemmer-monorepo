import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Combobox, DropdownMenu, RadioGroup, Switch } from "./controls";
import { DataTable } from "./layout";
import { Breadcrumbs, ErrorState } from "./navigation";
import { ToastProvider, useToast } from "./overlays";

describe("Switch", () => {
  it("toggles aria-checked and submits a value when on", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Switch
        label="Email receipts"
        name="receipts"
        onCheckedChange={onChange}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Email receipts" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(onChange).toHaveBeenCalledWith(true);
    expect(container.querySelector('input[name="receipts"]')).toHaveValue("on");
  });
});

describe("RadioGroup", () => {
  it("groups options under a legend", async () => {
    render(
      <RadioGroup
        legend="Billing cycle"
        name="cycle"
        defaultValue="monthly"
        options={[
          { value: "monthly", label: "Monthly" },
          { value: "yearly", label: "Yearly" },
        ]}
      />,
    );
    expect(
      screen.getByRole("group", { name: "Billing cycle" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Monthly" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Yearly" }));
    expect(screen.getByRole("radio", { name: "Yearly" })).toBeChecked();
  });
});

describe("Combobox", () => {
  const options = [
    { value: "08", label: "Rajasthan" },
    { value: "27", label: "Maharashtra" },
    { value: "29", label: "Karnataka" },
  ];

  it("filters as you type and picks with the keyboard", async () => {
    const onValue = vi.fn();
    const { container } = render(
      <Combobox
        label="State"
        name="state"
        options={options}
        onValueChange={onValue}
      />,
    );
    const input = screen.getByRole("combobox", { name: "State" });
    await userEvent.type(input, "ka");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Karnataka",
    ]);
    await userEvent.keyboard("{Enter}");
    expect(onValue).toHaveBeenCalledWith("29");
    expect(input).toHaveValue("Karnataka");
    expect(container.querySelector('input[name="state"]')).toHaveValue("29");
  });

  it("says when nothing matches", async () => {
    render(<Combobox label="State" options={options} />);
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

describe("DropdownMenu", () => {
  it("opens, moves focus with arrows, and closes on Escape back to the button", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        label="Actions"
        items={[
          { label: "Edit", onSelect },
          { label: "Archive", onSelect: () => {}, danger: true },
        ]}
      />,
    );
    const button = screen.getByRole("button", { name: "Actions" });
    await userEvent.click(button);
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("DataTable", () => {
  const columns = [
    {
      key: "name",
      header: "Name",
      cell: (r: { name: string }) => r.name,
      sortable: true,
    },
    { key: "city", header: "City", cell: () => "Jaipur" },
  ];

  it("marks the sorted column and links to the opposite direction", () => {
    render(
      <DataTable
        caption="Branches"
        columns={columns}
        rows={[{ name: "Main" }]}
        rowKey={(r) => r.name}
        sort={{ key: "name", dir: "asc" }}
        sortHref={(s) => `?sort=${s.key}&dir=${s.dir}`}
      />,
    );
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("link", { name: /Name/ })).toHaveAttribute(
      "href",
      "?sort=name&dir=desc",
    );
  });

  it("shows loading rows, then the error state when given one", () => {
    const { rerender, container } = render(
      <DataTable
        caption="x"
        columns={columns}
        rows={[]}
        rowKey={() => "x"}
        loading
      />,
    );
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    rerender(
      <DataTable
        caption="x"
        columns={columns}
        rows={[]}
        rowKey={() => "x"}
        error={<ErrorState title="Could not load" />}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
  });
});

describe("Breadcrumbs", () => {
  it("marks the last crumb as the current page", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Branches", href: "/branches" },
          { label: "C-Scheme" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Branches" })).toHaveAttribute(
      "href",
      "/branches",
    );
    expect(screen.getByText("C-Scheme")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("Toast", () => {
  function Trigger() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast("Saved")}>
        Save
      </button>
    );
  }

  it("announces messages in a live region and can be dismissed", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
