import { PrismaClient } from '@prisma/client';
import { forceChallengeCode, forgetSentCodes } from './_fixture.mjs';
const prisma = new PrismaClient();
if (process.argv[2] === 'forget') await forgetSentCodes(prisma, process.argv[3]);
else await forceChallengeCode(prisma, process.argv[2]);
await prisma.$disconnect();
