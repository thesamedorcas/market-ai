import { NextResponse } from "next/server";
import { getGlobalHistory } from "@/lib/db";

export async function GET() {
  const history = getGlobalHistory(8);
  return NextResponse.json({ history });
}
