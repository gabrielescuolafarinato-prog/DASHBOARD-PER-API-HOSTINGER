import { Badge, Card, PageHeading } from "@/components/ui";
import {
  listCapabilities,
  type CapabilityState,
} from "@/lib/hostinger/capabilities";

export const metadata = { title: "Capabilities" };

const groups: { state: CapabilityState; title: string; description: string }[] = [
  { state: "IMPLEMENTED", title: "Implemented", description: "Available in this foundation release." },
  { state: "PLANNED", title: "Available · not implemented", description: "Public API surface exists, but no active UI control is exposed yet." },
  { state: "NOT_AVAILABLE", title: "Not available via public API", description: "Hostinger does not expose a suitable public endpoint." },
  { state: "DENIED", title: "Denied by boundary", description: "Global or insufficiently confinable operations remain blocked." },
];

export default function CapabilitiesPage() {
  const capabilities = listCapabilities();
  return (
    <>
      <PageHeading
        eyebrow="Default deny"
        title="Capabilities"
        description="Every Hostinger operation must be registered here. Unknown keys are denied automatically."
      />
      <div className="space-y-5">
        {groups.map((group) => {
          const items = capabilities.filter((item) => item.state === group.state);
          return (
            <Card key={group.state} className="p-0">
              <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
                <div>
                  <h2 className="text-sm font-bold text-slate-900">{group.title}</h2>
                  <p className="mt-1 text-xs text-slate-500">{group.description}</p>
                </div>
                <Badge tone={tone(group.state)}>{items.length}</Badge>
              </div>
              <div className="grid divide-y divide-slate-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                {items.map((item, index) => (
                  <div
                    key={item.key}
                    className={`p-5 ${index >= 2 ? "border-t border-slate-100" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                        <code className="mt-1 block text-[11px] text-teal-700">{item.key}</code>
                      </div>
                      <Badge>{item.category}</Badge>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-slate-500">{item.description}</p>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function tone(state: CapabilityState): "success" | "warning" | "danger" | "neutral" {
  if (state === "IMPLEMENTED") return "success";
  if (state === "PLANNED") return "warning";
  if (state === "DENIED") return "danger";
  return "neutral";
}
