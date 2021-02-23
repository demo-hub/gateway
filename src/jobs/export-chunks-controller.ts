import { getPendingExports, startedExport } from "../database/chunk-db";
import {
  getConnectionPool,
  initConnectionPool,
  releaseConnectionPool,
} from "../database/postgres";

import knex from "knex";
import { wait } from "../lib/helpers";
import { ScheduledEvent, ScheduledHandler, Context } from "aws-lambda";
import log from "../lib/log";
import { enqueue, getQueueUrl } from "../lib/queues";
import { pick } from "lodash";
import { ExportChunk } from "../interfaces/messages";

let pool: knex;

export const handler: ScheduledHandler = async (
  event: ScheduledEvent,
  context: Context
) => {
  initConnectionPool("write");

  log.info(`[export-chunk-controller] creating db connection`);

  // This may be slow, so kill the DB connection 1 seconds before the runtime
  // is about to be force closed, as this can lead to connection leaks if they're
  // left open and not properly pruned.
  setTimeout(releaseConnectionPool, context.getRemainingTimeInMillis() - 1000);

  await wait(100);

  try {
    pool = getConnectionPool("write");

    log.info(`[export-chunk-controller] getting pooled connection`);

    const pending = await getPendingExports(pool, { limit: 100 });

    const queueUrl = getQueueUrl("export-chunks");

    log.info(
      `[export-chunk-controller] queuing ${pending.length} chunks for export`,
      { pending, queueUrl }
    );

    for (let index = 0; index < pending.length; index++) {
      const chunk = pending[index];

      log.info(`[export-chunk-controller] processing`, {
        root: chunk.data_path,
        offset: chunk.offset,
      });

      await Promise.all([
        enqueue<ExportChunk>(queueUrl, {
          size: chunk.chunk_size,
          header: pick(chunk, [
            "data_root",
            "data_size",
            "data_path",
            "offset",
          ]),
        }),
        startedExport(pool, {
          data_root: chunk.data_root,
          data_size: chunk.data_size,
          offset: chunk.offset,
        }),
      ]);
    }

    log.info(`[export-chunk-controller] export queuing complete`);
  } catch (error) {
    log.error(error);
  }

  await releaseConnectionPool();
  await wait(500);
};