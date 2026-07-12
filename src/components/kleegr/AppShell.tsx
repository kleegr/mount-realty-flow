import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  LayoutDashboard,
  Upload,
  History,
  Building2,
  Settings,
  LogOut,
  RefreshCw,
  Search,
  Webhook,
} from "lucide-react";
import { KleegrLogo } from "./KleegrLogo";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/import", label: "Import Center", icon: Upload },
  { to: "/import/history", label: "Import History", icon: History },
  { to: "/inventory", label: "Inventory", icon: Building2 },
  { to: "/tools/id-lookup", label: "CRM ID Lookup", icon: Search },
  { to: "/settings/sync", label: "Sync from CRM", icon: RefreshCw },
  { to: "/settings/webhook-guide", label: "Webhook Guide", icon: Webhook },
  { to: "/settings/crm", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children, userEmail }: { children: ReactNode; userEmail?: string | null }) {
  const router = useRouter();
  const currentPath = router.state.location.pathname;

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-64 flex-col bg-sidebar text-sidebar-foreground md:flex">
        <div className="p-5">
          <div className="rounded-lg bg-sidebar-accent/40 px-3 py-2.5">
            <KleegrLogo />
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => {
            const active = currentPath === item.to || (item.to !== "/dashboard" && currentPath.startsWith(item.to));
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-4">
          <div className="mb-2 truncate text-xs text-sidebar-foreground/60">{userEmail}</div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={signOut}
          >
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
