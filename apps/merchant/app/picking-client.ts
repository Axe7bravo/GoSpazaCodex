"use client";
import { createPickingClient, PickingError } from "@gospaza/api-client";
import type { PickingStatus } from "@gospaza/contracts";
export const pickingClient = createPickingClient(process.env.NEXT_PUBLIC_API_URL!);
export const pickingError = (error: unknown) => error instanceof PickingError ? error.message : "Picking is unavailable. Refresh before continuing.";
export const pickingLabels: Record<PickingStatus, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", COMPLETED: "Completed" };
export const assigneeLabel = (id: string | null, self: string) => !id ? "Unclaimed" : id === self ? "You (" + id + ")" : "Member " + id;
