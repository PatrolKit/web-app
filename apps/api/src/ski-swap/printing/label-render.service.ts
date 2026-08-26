import { Injectable } from '@nestjs/common';
import { PrinterService } from '../printer.service';
import { LabelRendererService } from './label-renderer.service';
import { PrintRecipeService, printTargetFor, type PrintRecipeKind } from './print-recipe.service';
import type { RenderLabelResponse } from '../../contracts/ski-swap.contracts';

/**
 * The browser's entry point into the renderer.
 *
 * Everything it does is also done on the claim path — resolve the recipe
 * against this printer's geometry, hand back finished pages — so the browser
 * and the bridge print the same label from the same code.
 */
@Injectable()
export class LabelRenderService {
  constructor(
    private readonly printers: PrinterService,
    private readonly recipes: PrintRecipeService,
    private readonly renderer: LabelRendererService,
  ) {}

  async render(
    orgId: string,
    printerId: string,
    userId: string,
    body: {
      kind: PrintRecipeKind;
      format: 'escpos' | 'png';
      itemId?: string;
      sellerId?: string;
      swapId?: string;
    },
  ): Promise<RenderLabelResponse> {
    const printer = await this.printers.assertPrinterAccess(orgId, printerId, userId);
    const target = printTargetFor(printer);

    const pages = await this.recipes.resolve(
      orgId,
      {
        kind: body.kind,
        itemId: body.itemId ?? null,
        sellerId: body.sellerId ?? null,
        swapId: body.swapId ?? null,
        printerId,
      },
      target,
    );

    return {
      format: body.format,
      pages: pages.map((rows) =>
        body.format === 'png'
          ? this.renderer.toPng(rows).toString('base64')
          : Buffer.from(this.renderer.toPrintJob(rows)).toString('base64'),
      ),
    };
  }
}
