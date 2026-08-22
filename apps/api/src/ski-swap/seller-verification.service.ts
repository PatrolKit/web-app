import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';

const EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class SellerVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  async initiateEmail(sellerId: string, orgId: string): Promise<void> {
    const seller = await this.prisma.swapSeller.findFirst({ where: { id: sellerId, orgId } });
    if (!seller) throw new NotFoundException('Seller not found');
    if (!seller.email) throw new BadRequestException('Seller has no email address on record');

    const rawToken = randomBytes(32).toString('hex');
    const code = sha256(rawToken);
    const expiresAt = new Date(Date.now() + EXPIRY_MS);

    await this.prisma.sellerVerification.create({
      data: { sellerId, channel: 'email', code, expiresAt },
    });

    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const verifyUrl = `${appUrl}/app/verify-seller?sellerId=${encodeURIComponent(sellerId)}&token=${rawToken}`;
    await this.mail.sendVerificationEmail(seller.email, verifyUrl);
  }

  async initiatePhone(sellerId: string, orgId: string): Promise<void> {
    const seller = await this.prisma.swapSeller.findFirst({ where: { id: sellerId, orgId } });
    if (!seller) throw new NotFoundException('Seller not found');

    const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
    const code = sha256(rawOtp);
    const expiresAt = new Date(Date.now() + EXPIRY_MS);

    await this.prisma.sellerVerification.create({
      data: { sellerId, channel: 'phone', code, expiresAt },
    });

    const body = `Your PatrolKit verification code is: ${rawOtp}. Expires in 15 minutes.`;
    await this.sms.send(seller.phone, body);
  }

  async confirmEmail(sellerId: string, rawToken: string): Promise<void> {
    await this.confirm(sellerId, 'email', rawToken, 'emailVerifiedAt');
  }

  async confirmPhone(sellerId: string, rawCode: string): Promise<void> {
    await this.confirm(sellerId, 'phone', rawCode, 'phoneVerifiedAt');
  }

  private async confirm(
    sellerId: string,
    channel: string,
    rawValue: string,
    stampField: 'emailVerifiedAt' | 'phoneVerifiedAt',
  ): Promise<void> {
    const hash = sha256(rawValue);
    const verification = await this.prisma.sellerVerification.findFirst({
      where: {
        sellerId,
        channel,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!verification || verification.code !== hash) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.sellerVerification.update({
        where: { id: verification.id },
        data: { usedAt: now },
      }),
      this.prisma.swapSeller.update({
        where: { id: sellerId },
        data: { [stampField]: now },
      }),
    ]);
  }
}
