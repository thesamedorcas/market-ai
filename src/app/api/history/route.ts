import { NextResponse } from "next/server";
import { getGlobalHistory } from "@/lib/db";

export async function GET() {
  const history = getGlobalHistory(8).slice(0, 5);
  return NextResponse.json({ history });
}
