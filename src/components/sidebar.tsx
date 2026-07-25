"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  FileClock,
  Gauge,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/overview", label: "Overview", icon: Gauge },
  { href: "/team", label: "Team", icon: Users },
  { href: "/site-settings", label: "Site settings", icon: Settings2 },
  { href: "/capabilities", label: "Capabilities", icon: Activity },
  { href: "/audit-log", label: "Audit log", icon: FileClock },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="border-b border-white/10 bg-[#0b2239] text-slate-200 lg:fixed lg:inset-y-0 lg:w-64 lg:border-b-0 lg:border-r">
      <div className="flex h-16 items-center gap-3 px-5 lg:h-20">
        <span className="grid size-9 place-items-center rounded-xl bg-teal-400 text-slate-950">
          <ShieldCheck className="size-5" />
        </span>
        <div>
          <p className="text-sm font-bold text-white">Site Console</p>
          <p className="text-[11px] text-slate-400">Hostinger Business</p>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:space-y-1 lg:px-3 lg:py-5">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                active
                  ? "bg-white/10 text-white shadow-inner"
                  : "text-slate-400 hover:bg-white/5 hover:text-white",
              )}
            >
              <item.icon className={cn("size-4", active && "text-teal-300")} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="absolute bottom-5 left-5 right-5 hidden rounded-xl border border-white/10 bg-white/5 p-3 lg:block">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">Security boundary</p>
        <p className="mt-1 text-xs leading-5 text-slate-400">All Hostinger targets are resolved on the server.</p>
      </div>
    </aside>
  );
}
