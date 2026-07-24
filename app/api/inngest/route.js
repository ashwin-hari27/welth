import { inngest } from "@/app/lib/inngest/client";
import { serve } from "inngest/next";
import { checkBudgetAlerts } from "./functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [checkBudgetAlerts],
});