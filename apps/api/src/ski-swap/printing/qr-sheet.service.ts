import { Injectable, NotFoundException } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'fs/promises';
import { join } from 'path';
import * as QRCode from 'qrcode';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The sheet a venue tapes to a self-service counter.
 *
 * The artwork is a designed PDF checked in beside this file, not something
 * drawn here: it carries fonts, a striped background and a card that would be
 * tedious to reproduce and worse to keep in sync. The server's whole job is to
 * put a QR code in the space left for one, so a station's sheet is the design
 * plus the one thing only the server knows.
 */

/** Where the template leaves room for the code, in PDF points from bottom-left. */
const DROP_ZONE = { x: 162, y: 163.5, size: 288 } as const;

/** Cream, matching the template's background so the station name sits on it. */
const INK = rgb(0.0944, 0.1259, 0.159);

@Injectable()
export class QrSheetService {
  private template: Buffer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async loadTemplate(): Promise<Buffer> {
    // Read once. The file ships with the build and never changes at runtime.
    if (!this.template) {
      this.template = await readFile(join(__dirname, 'assets', 'checkin-qr-template.pdf'));
    }
    return this.template;
  }

  /**
   * The address a seller's phone lands on. Built from the same parts as the
   * on-screen QR, so a printed sheet and the screen cannot disagree about where
   * a scan goes.
   */
  checkinUrl(swapId: string, stationId: string): string {
    const base = this.config.get<string>('app.sellerSiteUrl', 'http://localhost:3000');
    return `${base}/app/checkin?swap=${swapId}&station=${stationId}`;
  }

  async render(orgId: string, stationId: string): Promise<{ pdf: Uint8Array; filename: string }> {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null },
    });
    if (!station) throw new NotFoundException('Station not found');

    // A code points at one swap, so there has to be one running. The button is
    // disabled without it, but a link can still be typed.
    const swap = await this.prisma.skiSwap.findFirst({
      where: { orgId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!swap) {
      throw new NotFoundException(
        'No swap is running, and a check-in code points at one. Start a swap first.',
      );
    }

    const url = this.checkinUrl(swap.id, station.id);

    // Rendered at 4x the printed size so the modules stay crisp on paper, and
    // with the quiet zone the spec asks for — a code printed hard against the
    // card edge is one many scanners refuse.
    const qrPng = await QRCode.toBuffer(url, {
      type: 'png',
      width: DROP_ZONE.size * 4,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    const doc = await PDFDocument.load(await this.loadTemplate());
    const page = doc.getPage(0);

    // The template's drop zone is a dashed box with instructions in it. Cover
    // it rather than trusting the code to hide it: the QR's quiet zone is white
    // and would leave the border showing through around the edges.
    page.drawRectangle({
      x: DROP_ZONE.x,
      y: DROP_ZONE.y,
      width: DROP_ZONE.size,
      height: DROP_ZONE.size,
      color: rgb(1, 1, 1),
    });

    page.drawImage(await doc.embedPng(qrPng), {
      x: DROP_ZONE.x,
      y: DROP_ZONE.y,
      width: DROP_ZONE.size,
      height: DROP_ZONE.size,
    });

    // Below the card, in the band the design leaves empty. Several sheets get
    // printed at once and someone has to tape the right one to the right table.
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = 20;
    const width = font.widthOfTextAtSize(station.name, size);
    page.drawText(station.name, {
      x: (page.getWidth() - width) / 2,
      y: 92,
      size,
      font,
      color: INK,
    });

    return {
      pdf: await doc.save(),
      // Spaces and slashes in a station name would otherwise reach the
      // Content-Disposition header, where they mean something.
      filename: `checkin-${station.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.pdf`,
    };
  }
}
