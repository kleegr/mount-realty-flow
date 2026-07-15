import { createFileRoute, useRouter, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { pinLogin } from "@/lib/pin-auth.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { KleegrLogo } from "@/components/kleegr/KleegrLogo";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/dashboard" });
  },
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const pinFn = useServerFn(pinLogin);
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function submitPin(value: string) {
    if (loading || value.length < 4) return;
    setLoading(true);
    try {
      const res = await pinFn({ data: { pin: value } });
      if (!res.ok) {
        toast.error(res.error);
        setPin("");
        return;
      }
      const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: res.tokenHash });
      if (error) {
        toast.error(error.message);
        setPin("");
        return;
      }
      router.navigate({ to: "/dashboard" });
    } finally {
      setLoading(false);
    }
  }

  async function signInEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    router.navigate({ to: "/dashboard" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-secondary/40 to-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <KleegrLogo />
        </div>
        <Card className="shadow-elevated">
          <CardHeader className="text-center">
            <CardTitle>Enter PIN</CardTitle>
            <CardDescription>Mount Realty inventory portal</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <InputOTP
              maxLength={4}
              value={pin}
              onChange={(v) => {
                setPin(v);
                if (v.length === 4) void submitPin(v);
              }}
              disabled={loading}
              autoFocus
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={1} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={2} className="h-14 w-14 text-2xl" />
                <InputOTPSlot index={3} className="h-14 w-14 text-2xl" />
              </InputOTPGroup>
            </InputOTP>
            <Button className="w-full" disabled={loading || pin.length < 4} onClick={() => void submitPin(pin)}>
              {loading ? "Unlocking…" : "Unlock"}
            </Button>

            {!showEmail ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setShowEmail(true)}
              >
                Admin sign-in with email
              </button>
            ) : (
              <form onSubmit={signInEmail} className="w-full space-y-3 border-t pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                  Sign in
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
