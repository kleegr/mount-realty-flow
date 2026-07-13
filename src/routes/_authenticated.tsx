import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/kleegr/AppShell";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getAccessStatus } from "@/lib/admin.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  const accessFn = useServerFn(getAccessStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["access-status"],
    queryFn: () => accessFn(),
    staleTime: 30_000,
  });

  if (!isLoading && data && !data.approved) {
    return <PendingApproval email={email} />;
  }

  return (
    <AppShell userEmail={email}>
      <Outlet />
    </AppShell>
  );
}

function PendingApproval({ email }: { email: string | null }) {
  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-secondary/40 to-background px-4">
      <Card className="w-full max-w-md shadow-elevated">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
            <Clock className="h-5 w-5 text-muted-foreground" />
          </div>
          <CardTitle>Awaiting approval</CardTitle>
          <CardDescription>
            Your account ({email}) is pending authorization. An administrator must grant
            you access before you can use the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={signOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
