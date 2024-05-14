import { Client } from "langsmith";
import { RunTree } from "langsmith/run_trees";
import {
  type TraceableFunction,
  isTraceableFunction,
  getCurrentRunTree,
} from "langsmith/singletons/traceable";

import {
  BaseRun,
  RunCreate,
  RunUpdate as BaseRunUpdate,
  KVMap,
} from "langsmith/schemas";
import { getEnvironmentVariable, getRuntimeEnvironment } from "../utils/env.js";
import { BaseTracer } from "./base.js";
import { BaseCallbackHandlerInput } from "../callbacks/base.js";
import { Runnable } from "../runnables/base.js";
import {
  RunnableConfig,
  getCallbackManagerForConfig,
} from "../runnables/config.js";

export interface Run extends BaseRun {
  id: string;
  child_runs: this[];
  child_execution_order: number;
  dotted_order?: string;
  trace_id?: string;
}

export interface RunCreate2 extends RunCreate {
  trace_id?: string;
  dotted_order?: string;
}

export interface RunUpdate extends BaseRunUpdate {
  events: BaseRun["events"];
  inputs: KVMap;
  trace_id?: string;
  dotted_order?: string;
}

export interface LangChainTracerFields extends BaseCallbackHandlerInput {
  exampleId?: string;
  projectName?: string;
  client?: Client;
}

export class LangChainTracer
  extends BaseTracer
  implements LangChainTracerFields
{
  name = "langchain_tracer";

  projectName?: string;

  exampleId?: string;

  client: Client;

  constructor(fields: LangChainTracerFields = {}) {
    super(fields);
    const { exampleId, projectName, client } = fields;

    this.projectName =
      projectName ??
      getEnvironmentVariable("LANGCHAIN_PROJECT") ??
      getEnvironmentVariable("LANGCHAIN_SESSION");
    this.exampleId = exampleId;
    this.client = client ?? new Client({});

    // if we're inside traceable, we can obtain the traceable tree
    // and populate the run map, which is used to correctly
    // infer dotted order and execution order
    const traceableTree = this.getTraceableRunTree();
    if (traceableTree) {
      let rootRun: RunTree = traceableTree;
      const visited = new Set<string>();
      while (rootRun.parent_run) {
        if (visited.has(rootRun.id)) break;
        visited.add(rootRun.id);

        if (!rootRun.parent_run) break;
        rootRun = rootRun.parent_run as RunTree;
      }
      visited.clear();

      const queue = [rootRun];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current.id)) continue;
        visited.add(current.id);

        // @ts-expect-error KVMap is not assignable to Run["events"]
        this.runMap.set(current.id, current);
        if (current.child_runs) {
          queue.push(...current.child_runs);
        }
      }

      this.client = traceableTree.client ?? this.client;
    }
  }

  private async _convertToCreate(
    run: Run,
    example_id: string | undefined = undefined
  ): Promise<RunCreate> {
    return {
      ...run,
      extra: {
        ...run.extra,
        runtime: await getRuntimeEnvironment(),
      },
      child_runs: undefined,
      session_name: this.projectName,
      reference_example_id: run.parent_run_id ? undefined : example_id,
    };
  }

  protected async persistRun(_run: Run): Promise<void> {}

  async onRunCreate(run: Run): Promise<void> {
    const persistedRun: RunCreate2 = await this._convertToCreate(
      run,
      this.exampleId
    );
    await this.client.createRun(persistedRun);
  }

  async onRunUpdate(run: Run): Promise<void> {
    const runUpdate: RunUpdate = {
      end_time: run.end_time,
      error: run.error,
      outputs: run.outputs,
      events: run.events,
      inputs: run.inputs,
      trace_id: run.trace_id,
      dotted_order: run.dotted_order,
      parent_run_id: run.parent_run_id,
    };
    await this.client.updateRun(run.id, runUpdate);
  }

  getRun(id: string): Run | undefined {
    return this.runMap.get(id);
  }

  getTraceableRunTree(): RunTree | undefined {
    try {
      return getCurrentRunTree();
    } catch {
      return undefined;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTraceableFunction = TraceableFunction<(...any: any[]) => any>;

/**
 * A runnabble that runs a traced function from LangSmith
 */
export class RunnableTraceable<RunInput, RunOutput> extends Runnable<
  RunInput,
  RunOutput
> {
  lc_serializable = false;

  lc_namespace = ["langchain_core", "runnables"];

  protected func: AnyTraceableFunction;

  constructor(fields: { func: AnyTraceableFunction }) {
    super(fields);

    if (!isTraceableFunction(fields.func)) {
      throw new Error(
        "RunnableTraceable requires a function that is wrapped in traceable higher-order function"
      );
    }

    this.func = fields.func;
  }

  async invoke(input: RunInput, options?: Partial<RunnableConfig>) {
    const [config] = this._getOptionsList(options ?? {}, 1);
    return (await this.func(
      { ...config, callbacks: await getCallbackManagerForConfig(config) },
      input
    )) as RunOutput;
  }
}
