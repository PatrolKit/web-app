import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SquareClient, SquareEnvironment } from 'square';
import { SquareCryptoService } from './square-crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export const SQUARE_VERSION = '2026-07-16';

@Injectable()
export class SquareClientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SquareCryptoService,
  ) {}

  async forOrg(orgId: string): Promise<SquareClient> {
    const config = await this.prisma.squareConfig.findUnique({ where: { orgId } });
    if (!config) {
      // Structured, so the code reaches the client: the exception filter reads
      // `message` and `code` off the response object, and the second string
      // argument lands in neither. Callers with something more specific to say
      // catch this and re-throw with it — see SwapService.
      throw new ServiceUnavailableException({
        message: 'Square is not configured for this organization',
        code: 'SQUARE_NOT_CONFIGURED',
      });
    }
    const token = this.crypto.decrypt(config.accessTokenEnc);
    return new SquareClient({
      token,
      environment: config.environment === 'sandbox' ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
    });
  }
}
