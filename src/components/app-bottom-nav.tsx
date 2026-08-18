import { FileText, Mic, UserRound } from "lucide-react";
import Link from "next/link";

export type AppNavItem = "record" | "meetings" | "account";

const items = [
  { href: "/app", icon: Mic, id: "record" as const, label: "记录" },
  { href: "/meetings", icon: FileText, id: "meetings" as const, label: "会议" },
  { href: "/account", icon: UserRound, id: "account" as const, label: "我的" },
];

export function AppBottomNav({ active, hiddenOnDesktop = false }: { active: AppNavItem; hiddenOnDesktop?: boolean }) {
  return (
    <nav
      aria-label="主导航"
      className={`app-bottom-nav fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[430px] px-3 pb-[max(0.55rem,env(safe-area-inset-bottom))] pt-1.5 text-[11px] font-semibold sm:absolute ${
        hiddenOnDesktop ? "lg:hidden" : ""
      }`}
      data-app-primary-nav="record-meetings-account"
    >
      <div className="grid grid-cols-3 gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={`app-bottom-item ${isActive ? "text-[#07845f]" : ""}`}
              href={item.href}
              key={item.id}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
