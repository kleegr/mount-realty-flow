import { cn } from "@/lib/utils";

export function KleegrLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 10 12 3l8 7v10a1 1 0 0 1-1 1h-5v-7h-4v7H5a1 1 0 0 1-1-1V10Z" fill="currentColor" opacity="0.9"/>
          <path d="M15 12h3v3h-3z" fill="var(--accent)"/>
        </svg>
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-base font-bold tracking-tight text-foreground">Kleegr</span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Mount Realty</span>
      </div>
    </div>
  );
}
