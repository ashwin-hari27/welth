"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

export async function createTransaction(data) {
    try {
        const { userId } = await auth();
        if (!userId) throw new Error("Unauthorized");

        const user = await db.user.findUnique({
            where: { clerkUserId: userId },
        });

        if (!user) {
            throw new Error("User not found");
        }

        const account = await db.account.findUnique({
            where: {
                id: data.accountId,
                userId: user.id,
            },
        });

        if (!account) {
            throw new Error("Account not found");
        }

        const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
        const newBalance = account.balance.toNumber() + balanceChange;

        const transaction = await db.$transaction(async (tx) => {
            const newTransaction = await tx.transaction.create({
                data: {
                    ...data,
                    userId: user.id,
                    nextRecurringDate:
                        data.isRecurring && data.recurringInterval
                            ? calculateNextRecurringDate(data.date, data.recurringInterval)
                            : null,
                },
            });
            await tx.account.update({
                where: { id: data.accountId },
                data: { balance: newBalance },
            });
            return newTransaction;
        });
        revalidatePath("/dashboard");
        revalidatePath(`/account/${transaction.accountId}`);

        return { success: true, data: serializeAmount(transaction) };
    } catch (error) {
        throw new Error(error.message);
     }
}


export async function scanReceipt(file) {
    try {
        const { userId } = await auth();
        if (!userId) throw new Error("Unauthorized");

        // Convert the uploaded file to base64 so it can be sent inline to Gemini
        const arrayBuffer = await file.arrayBuffer();
        const base64String = Buffer.from(arrayBuffer).toString("base64");

        const prompt = `
            Analyze this receipt image and extract the following information in JSON format:
            - Total amount (just the number, no currency symbol)
            - Date (in ISO format, e.g. 2026-07-18)
            - Description or a short summary of what was purchased
            - Merchant or store name
            - Suggested category - must be exactly one of these ids:
              housing, transportation, groceries, utilities, entertainment, food,
              shopping, healthcare, education, personal, travel, insurance, gifts,
              bills, other-expense

            Only respond with valid JSON in this exact format and nothing else:
            {
                "amount": number,
                "date": "ISO date string",
                "description": "string",
                "merchantName": "string",
                "category": "string"
            }

            If the image is not a receipt, respond with an empty JSON object: {}
        `;

        const result = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                data: base64String,
                                mimeType: file.type,
                            },
                        },
                        { text: prompt },
                    ],
                },
            ],
        });

        const text = result.text;
        // Gemini sometimes wraps JSON in markdown code fences - strip those out
        const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

        let data;
        try {
            data = JSON.parse(cleanedText);
        } catch (parseError) {
            throw new Error("Failed to read receipt. Try a clearer image.");
        }

        if (!data || !data.amount) {
            throw new Error("Could not detect a valid receipt in this image.");
        }

        const validCategories = [
            "housing", "transportation", "groceries", "utilities", "entertainment",
            "food", "shopping", "healthcare", "education", "personal", "travel",
            "insurance", "gifts", "bills", "other-expense",
        ];

        return {
            amount: parseFloat(data.amount),
            date: new Date(data.date),
            description: data.description || "",
            merchantName: data.merchantName || "",
            category: validCategories.includes(data.category)
                ? data.category
                : "other-expense",
        };
    } catch (error) {
        console.error("Error scanning receipt:", error.message);
        throw new Error(error.message || "Failed to scan receipt");
    }
}

function calculateNextRecurringDate(startDate, interval) {
    const date = new Date(startDate);

    switch (interval) {
        case "DAILY":
            date.setDate(date.getDate() + 1);
            break;
        case "WEEKLY":
            date.setDate(date.getDate() + 7);
            break;
        case "MONTHLY":
            date.setMonth(date.getMonth() + 1);
            break;
        case "YEARLY":
            date.setFullYear(date.getFullYear() + 1);
            break;
    }

    return date;
}