// Demo data mirroring the assignment scenario: the flat-mates group with the
// real membership timeline (Meera leaves end of March, Sam joins mid-April,
// Dev is a trip guest). No expenses are seeded — they are loaded by importing
// public/expenses_export.csv through the app, which is the graded flow.
//
// Run: npm run db:seed   (idempotent — skips if the group already exists)

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PEOPLE = [
  { email: "aisha@example.com", name: "Aisha" },
  { email: "rohan@example.com", name: "Rohan" },
  { email: "priya@example.com", name: "Priya" },
  { email: "meera@example.com", name: "Meera" },
  { email: "dev@example.com", name: "Dev" },
  { email: "sam@example.com", name: "Sam" },
];

async function main() {
  const passwordHash = await bcrypt.hash("password123", 12);

  const users: Record<string, { id: string }> = {};
  for (const { email, name } of PEOPLE) {
    users[name] = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name, passwordHash },
    });
  }

  if (await prisma.group.findFirst({ where: { name: "Flat 4B" } })) {
    console.log("Seed group already exists — skipping.");
    return;
  }

  // Membership timeline (drives the CSV's membership-timing anomalies):
  //  - Aisha/Rohan/Priya: from the start, never left.
  //  - Meera: from the start, left 2026-03-31 (moved out end of March).
  //  - Dev: trip guest, modelled as joined from the start (appears Feb–Mar).
  //  - Sam: joined 2026-04-08 (moved in, paid his deposit that day).
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  await prisma.group.create({
    data: {
      name: "Flat 4B",
      description: "Shared flat expenses — Feb–Apr 2026 (import expenses_export.csv)",
      baseCurrency: "INR",
      createdById: users.Aisha.id,
      members: {
        create: [
          { userId: users.Aisha.id, role: "ADMIN", joinedAt: d("2026-02-01") },
          { userId: users.Rohan.id, joinedAt: d("2026-02-01") },
          { userId: users.Priya.id, joinedAt: d("2026-02-01") },
          { userId: users.Meera.id, joinedAt: d("2026-02-01"), leftAt: d("2026-03-31") },
          { userId: users.Dev.id, joinedAt: d("2026-02-01") },
          { userId: users.Sam.id, joinedAt: d("2026-04-08") },
        ],
      },
    },
  });

  console.log(
    "Seeded group 'Flat 4B' with Aisha/Rohan/Priya/Meera/Dev/Sam (password: password123).\n" +
      "Log in as aisha@example.com and import public/expenses_export.csv.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
