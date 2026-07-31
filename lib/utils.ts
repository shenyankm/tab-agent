import { useEffect, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Subscribe to a WXT storage item: initial read + live watch across pages. */
export function useStorageValue<T>(
  item: { getValue(): Promise<T>; watch(cb: (value: T) => void): () => void },
  initial: T,
): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    item.getValue().then(setValue);
    return item.watch(setValue);
  }, [item]);
  return value;
}
