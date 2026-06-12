// Demo data: three users, one group, one expense per split type, one
// settlement, and a departed member to exercise membership timing.
// Run: npm run db:seed   (idempotent — upserts by email / skips if present)

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash("password123", 12);

  const [alice, bob, carol, dave] = await Promise.all(
    [
      ["alice@example.com", "Alice"],
      ["bob@example.com", "Bob"],
      ["carol@example.com", "Carol"],
      ["dave@example.com", "Dave"],
    ].map(([email, name]) =>
      prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, name, passwordHash: password },
      }),
    ),
  );

  const existing = await prisma.group.findFirst({ where: { name: "Goa Trip" } });
  if (existing) {
    console.log("Seed group already exists — skipping.");
    return;
  }

  const group = await prisma.group.create({
    data: {
      name: "Goa Trip",
      description: "Demo group with all three split types",
      createdById: alice.id,
      members: {
        create: [
          { userId: alice.id, role: "ADMIN", joinedAt: new Date("2024-01-01T00:00:00Z") },
          { userId: bob.id, joinedAt: new Date("2024-01-01T00:00:00Z") },
          { userId: carol.id, joinedAt: new Date("2024-01-05T00:00:00Z") },
          {
            userId: dave.id,
            joinedAt: new Date("2024-01-01T00:00:00Z"),
            leftAt: new Date("2024-03-01T00:00:00Z"), // departed member for A13 demos
          },
        ],
      },
    },
  });

  // EQUAL: $100 / 3 -> 3334 + 3333 + 3333 (deterministic by user id order)
  const ids = [alice.id, bob.id, carol.id].sort();
  await prisma.expense.create({
    data: {
      groupId: group.id,
      paidById: alice.id,
      description: "Dinner at Beach Shack",
      amountCents: 10000,
      date: new Date("2024-02-10T00:00:00Z"),
      splitType: "EQUAL",
      splits: {
        create: ids.map((userId, i) => ({ userId, shareCents: i === 0 ? 3334 : 3333 })),
      },
    },
  });

  // EXACT: $30 taxi — Bob 20, Alice 10
  await prisma.expense.create({
    data: {
      groupId: group.id,
      paidById: bob.id,
      description: "Airport taxi",
      amountCents: 3000,
      date: new Date("2024-02-11T00:00:00Z"),
      splitType: "EXACT",
      splits: {
        create: [
          { userId: alice.id, shareCents: 1000 },
          { userId: bob.id, shareCents: 2000 },
        ],
      },
    },
  });

  // PERCENTAGE: $200 hotel — Alice 25%, Carol 75%
  await prisma.expense.create({
    data: {
      groupId: group.id,
      paidById: carol.id,
      description: "Hotel (2 nights)",
      amountCents: 20000,
      date: new Date("2024-02-12T00:00:00Z"),
      splitType: "PERCENTAGE",
      splits: {
        create: [
          { userId: alice.id, shareCents: 5000 },
          { userId: carol.id, shareCents: 15000 },
        ],
      },
    },
  });

  // One settlement: Bob pays Alice $20
  await prisma.settlement.create({
    data: {
      groupId: group.id,
      fromUserId: bob.id,
      toUserId: alice.id,
      amountCents: 2000,
      date: new Date("2024-02-15T00:00:00Z"),
      note: "UPI transfer",
    },
  });

  console.log("Seeded: alice/bob/carol/dave@example.com (password: password123), group 'Goa Trip'.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
