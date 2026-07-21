import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  LayoutDashboard,
  Upload,
  History,
  Building2,
  Settings,
  LogOut,
  BarChart3,
  ShieldCheck,
  FlaskConical,
  Menu as MenuIcon,
  ChevronDown,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyRoles } from "@/lib/crm-config.functions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Top-ribbon app shell, built for running INSIDE GoHighLevel as an embedded
 * custom link. GHL already draws its own dark/purple chrome above the iframe,
 * so this ribbon is deliberately LIGHT — white bar, navy text, amber accents —
 * to avoid two stacked dark bars fighting each other.
 *
 * INVENTORY is the front door (owner decision): it's the first tab, the brand
 * link, and where every sign-in lands. Day-to-day operations (Dashboard,
 * reports, history, settings) live in the Menu dropdown; rarely-used
 * technical tools were removed from the menu on purpose — their routes still
 * exist for direct links.
 */

const PRIMARY_NAV = [
  { to: "/inventory", label: "Inventory", icon: Building2, match: (p: string) => p.startsWith("/inventory") },
  {
    to: "/import",
    label: "Import Center",
    icon: Upload,
    match: (p: string) => p === "/import" || (p.startsWith("/import/") && !p.startsWith("/import/history")),
  },
] as const;

const MENU_NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/report", label: "Unit Report", icon: BarChart3 },
  { to: "/import/history", label: "Import History", icon: History },
  { to: "/settings/crm", label: "Settings", icon: Settings },
] as const;

const ADMIN_MENU_NAV = [
  { to: "/tools/crm-probe", label: "CRM Probe", icon: FlaskConical },
  { to: "/settings/admin", label: "Admin Panel", icon: ShieldCheck },
] as const;

export function AppShell({ children, userEmail }: { children: ReactNode; userEmail?: string | null }) {
  const router = useRouter();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const rolesFn = useServerFn(getMyRoles);
  const { data: rolesData } = useQuery({ queryKey: ["my-roles"], queryFn: () => rolesFn(), staleTime: 60_000 });
  const isAdmin = (rolesData?.roles ?? []).includes("admin");
  const menuItems = isAdmin ? [...MENU_NAV, ...ADMIN_MENU_NAV] : [...MENU_NAV];
  const menuActive = menuItems.some((item) => currentPath.startsWith(item.to));

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-2 px-3 sm:gap-4 sm:px-5">
          {/* Brand — navy square, amber-free so the underline is the only accent */}
          <Link to="/inventory" className="flex shrink-0 items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 10 12 3l8 7v10a1 1 0 0 1-1 1h-5v-7h-4v7H5a1 1 0 0 1-1-1V10Z" fill="currentColor" opacity="0.9" />
              </svg>
            </div>
            <div className="hidden flex-col leading-none sm:flex">
              <span className="text-sm font-bold tracking-tight text-foreground">Kleegr</span>
              <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">Mount Realty</span>
            </div>
          </Link>

          {/* Primary tabs */}
          <nav className="flex h-full flex-1 items-stretch gap-1 overflow-x-auto">
            {PRIMARY_NAV.map((item) => {
              const active = item.match(currentPath);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium transition-colors sm:px-3",
                    active
                      ? "border-accent text-foreground"
                      : "border-transparent text-muted-foreground hover:border-accent/40 hover:text-foreground",
                  )}
                >
                  <Icon className={cn("h-4 w-4", active ? "text-accent" : "")} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* Everything else lives in one Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 shrink-0 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground",
                  menuActive && "bg-secondary text-foreground",
                )}
              >
                <MenuIcon className="h-4 w-4" />
                <span className="hidden sm:inline">Menu</span>
                <ChevronDown className="h-3 w-3 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const active = currentPath.startsWith(item.to);
                return (
                  <DropdownMenuItem key={item.to} asChild>
                    <Link to={item.to} className={cn("flex w-full cursor-pointer items-center gap-2", active && "font-semibold")}> 
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}

              <DropdownMenuSeparator />
              {userEmail && (
                <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                  {userEmail}
                </DropdownMenuLabel>
              )}
              <DropdownMenuItem onClick={signOut} className="cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</div>
      </main>
    </div>
  );
}
