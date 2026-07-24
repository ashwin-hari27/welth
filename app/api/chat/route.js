import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Gemini's free tier occasionally returns 503 UNAVAILABLE when a model is
// under heavy load. These are transient - retrying with backoff usually succeeds.
// If the primary model stays overloaded, fall back to a lighter model that
// typically has more spare capacity.
const MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

async function generateWithRetry(baseParams, maxRetriesPerModel = 2) {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        return await ai.models.generateContent({ ...baseParams, model });
      } catch (error) {
        lastError = error;
        const status = error?.status || error?.error?.code;
        const isRetryable = status === 503 || status === 429;

        if (!isRetryable) {
          throw error;
        }

        if (attempt < maxRetriesPerModel) {
          const delayMs = 500 * 2 ** attempt; // 500ms, 1s
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        // otherwise fall through to the next model in MODELS
      }
    }
  }

  throw lastError;
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message, history = [] } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
      include: { accounts: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        date: { gte: startOfMonth },
      },
      orderBy: { date: "desc" },
      take: 200,
    });

    // Build a compact, factual summary of the user's real data
    const accountsSummary =
      user.accounts
        .map(
          (a) =>
            `- ${a.name} (${a.type}${a.isDefault ? ", default" : ""}): $${a.balance
              .toNumber()
              .toFixed(2)}`
        )
        .join("\n") || "No accounts yet.";

    let monthIncome = 0;
    let monthExpense = 0;
    const categoryTotals = {};

    for (const t of transactions) {
      const amt = t.amount.toNumber();
      if (t.type === "EXPENSE") {
        monthExpense += amt;
        categoryTotals[t.category] = (categoryTotals[t.category] || 0) + amt;
      } else {
        monthIncome += amt;
      }
    }

    const categorySummary =
      Object.entries(categoryTotals)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, total]) => `- ${cat}: $${total.toFixed(2)}`)
        .join("\n") || "No expenses recorded yet this month.";

    const recentTransactions =
      transactions
        .slice(0, 15)
        .map(
          (t) =>
            `- ${t.date.toISOString().split("T")[0]} | ${t.type} | $${t.amount
              .toNumber()
              .toFixed(2)} | ${t.category} | ${t.description || "no description"}`
        )
        .join("\n") || "No transactions yet.";

    const financialContext = `
ACCOUNTS:
${accountsSummary}

THIS MONTH'S SUMMARY (since ${startOfMonth.toDateString()}):
Total income: $${monthIncome.toFixed(2)}
Total expenses: $${monthExpense.toFixed(2)}

SPENDING BY CATEGORY THIS MONTH:
${categorySummary}

RECENT TRANSACTIONS (most recent first, max 15 shown):
${recentTransactions}
    `.trim();

    const systemInstruction = `
You are Welth's finance assistant. Answer the user's questions about their own
finances using ONLY the real data provided below - never invent or estimate numbers
that aren't in this data. Be concise and friendly, and format money as $X.XX.
If something can't be answered from the data given, say so honestly rather than
guessing. Do not give investment, tax, or legal advice - suggest a professional
for those questions instead.

USER'S FINANCIAL DATA:
${financialContext}
    `.trim();

    const contents = [
      ...history.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const result = await generateWithRetry({
      contents,
      config: { systemInstruction },
    });

    return NextResponse.json({ reply: result.text });
  } catch (error) {
    console.error("Chat error:", error);

    const status = error?.status || error?.error?.code;
    const message =
      status === 503
        ? "The AI service is experiencing high demand right now. Please try again in a moment."
        : "Something went wrong. Please try again.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}