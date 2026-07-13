import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listUsers,
  setUserRole,
  deleteUser,
  adminUpdateUserEmail,
} from "@/lib/admin.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, ShieldCheck, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/admin")({
  component: AdminPage,
});

const ROLE_OPTIONS = ["admin", "importer", "viewer", "pending"] as const;

function AdminPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const listFn = useServerFn(listUsers);
  const setRoleFn = useServerFn(setUserRole);
  const delFn = useServerFn(deleteUser);
  const adminEmailFn = useServerFn(adminUpdateUserEmail);

  const q = useQuery({ queryKey: ["admin-users"], queryFn: () => listFn() });

  const setRoleMut = useMutation({
    mutationFn: (v: { userId: string; role: (typeof ROLE_OPTIONS)[number] }) =>
      setRoleFn({ data: v }),
    onSuccess: () => {
      toast.success("Role updated");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delMut = useMutation({
    mutationFn: (userId: string) => delFn({ data: { userId } }),
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const emailMut = useMutation({
    mutationFn: (v: { userId: string; email: string }) => adminEmailFn({ data: v }),
    onSuccess: () => {
      toast.success("Email updated");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Update own email via Supabase auth (sends confirmation email)
  const [myEmail, setMyEmail] = useState("");
  async function updateMyEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!myEmail) return;
    const { error } = await supabase.auth.updateUser({ email: myEmail });
    if (error) toast.error(error.message);
    else toast.success("Confirmation link sent to the new email address.");
  }

  if (q.isLoading) return <div className="text-muted-foreground">Loading users…</div>;
  if (q.error)
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>{(q.error as Error).message}</AlertDescription>
      </Alert>
    );

  const users = q.data?.users ?? [];
  const currentUserId = q.data?.currentUserId;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin Panel</h1>
        <p className="text-sm text-muted-foreground">
          Authorize users and manage their access to the platform.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Change your email</CardTitle>
          <CardDescription>
            Update the email address for your admin account. A confirmation link is sent to
            the new address; access transfers once you confirm.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={updateMyEmail} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="new-email">New email</Label>
              <Input
                id="new-email"
                type="email"
                value={myEmail}
                onChange={(e) => setMyEmail(e.target.value)}
                placeholder="new-admin@company.com"
              />
            </div>
            <Button type="submit">Send confirmation</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Users & authorization
          </CardTitle>
          <CardDescription>
            New signups start as <Badge variant="outline">pending</Badge> and cannot access the app
            until you assign them a role. Roles: <b>admin</b> (full access + admin panel),{" "}
            <b>importer</b> (import & sync), <b>viewer</b> (read-only).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Change role</TableHead>
                  <TableHead>Change email</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === currentUserId}
                    onSetRole={(role) => setRoleMut.mutate({ userId: u.id, role })}
                    onDelete={() => {
                      if (confirm(`Delete ${u.email}? This cannot be undone.`))
                        delMut.mutate(u.id);
                    }}
                    onUpdateEmail={(email) => emailMut.mutate({ userId: u.id, email })}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  onSetRole,
  onDelete,
  onUpdateEmail,
}: {
  user: {
    id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    roles: string[];
  };
  isSelf: boolean;
  onSetRole: (role: (typeof ROLE_OPTIONS)[number]) => void;
  onDelete: () => void;
  onUpdateEmail: (email: string) => void;
}) {
  const [emailDraft, setEmailDraft] = useState(user.email ?? "");
  const currentRole = user.roles[0] ?? "pending";
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{user.email ?? "—"}</div>
        <div className="text-xs text-muted-foreground">
          Joined {new Date(user.created_at).toLocaleDateString()}
          {user.last_sign_in_at && ` · Last seen ${new Date(user.last_sign_in_at).toLocaleDateString()}`}
          {isSelf && " · You"}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0 ? (
            <Badge variant="outline">none</Badge>
          ) : (
            user.roles.map((r) => (
              <Badge key={r} variant={r === "pending" ? "outline" : r === "admin" ? "default" : "secondary"}>
                {r}
              </Badge>
            ))
          )}
        </div>
      </TableCell>
      <TableCell>
        <Select value={currentRole} onValueChange={(v) => onSetRole(v as (typeof ROLE_OPTIONS)[number])}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex gap-2">
          <Input
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            className="w-56"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!emailDraft || emailDraft === user.email}
            onClick={() => onUpdateEmail(emailDraft)}
          >
            Save
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          disabled={isSelf}
          onClick={onDelete}
          title={isSelf ? "You cannot delete yourself" : "Delete user"}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
