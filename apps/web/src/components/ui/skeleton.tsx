import { cn } from "@/lib/utils";
import "@/styles/bmq-loading.css";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bmq-ld bmq-ld-skeleton bmq-ld-shimmer rounded-md", className)} {...props} />;
}

export { Skeleton };
