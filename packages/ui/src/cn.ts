import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; a later class overrides an earlier conflicting one (`cn("p-2", "p-4")` → "p-4"). */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
