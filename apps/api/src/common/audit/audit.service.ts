import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';

export interface AuditEvent {
  actorType: 'user' | 'device' | 'system';
  actorId?: string;
  orgId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(event: AuditEvent): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: createId(),
        actorType: event.actorType,
        actorId: event.actorId,
        orgId: event.orgId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: event.metadata as object | undefined,
        ipAddress: event.ipAddress,
      },
    });
  }
}
