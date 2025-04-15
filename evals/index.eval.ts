/**
 * This script orchestrates the running of evaluations against a set of tasks.
 * It uses Braintrust to run multiple testcases (each testcase representing a
 * given task-model combination) and then aggregates the results, producing
 * a summary of passes, failures, and categorized success rates.
 *
 * Overview:
 * - Reads a configuration file `evals.config.json` to determine what tasks (evaluations)
 *   are available and which categories they belong to.
 * - Supports filtering which tasks to run either by evaluation category or by specific task name.
 * - Supports multiple models, defaulting to certain sets of models depending on the category.
 * - Runs each selected task against each selected model in parallel, collecting results.
 * - Saves a summary of the evaluation results to `eval-summary.json`.
 */
import fs from "fs";
import path from "path";
import process from "process";
import {
  DEFAULT_EVAL_CATEGORIES,
  filterByCategory,
  filterByEvalName,
  useTextExtract,
} from "./args";
import { generateExperimentName } from "./utils";
import { exactMatch, errorMatch } from "./scoring";
import { tasksByName, MODELS, tasksConfig } from "./taskConfig";
import { Eval, wrapAISDKModel, wrapOpenAI } from "braintrust";
import { EvalFunction, SummaryResult, Testcase } from "@/types/evals";
import { EvalLogger } from "./logger";
import { AvailableModel, LLMClient } from "@/dist";
import { env } from "./env";
import dotenv from "dotenv";
import { StagehandEvalError } from "@/types/stagehandErrors";
import { CustomOpenAIClient } from "@/examples/external_clients/customOpenAI";
import OpenAI from "openai";
import { initStagehand } from "./initStagehand";
import { AISdkClient } from "@/examples/external_clients/aisdk";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { cerebras } from "@ai-sdk/cerebras";
dotenv.config();

/**
 * Read max concurrency and trial count from environment variables set in args.ts.
 * Fallback to defaults (20 and 5) if they're not provided.
 */
const MAX_CONCURRENCY = process.env.EVAL_MAX_CONCURRENCY
  ? parseInt(process.env.EVAL_MAX_CONCURRENCY, 10)
  : 3;

const TRIAL_COUNT = process.env.EVAL_TRIAL_COUNT
  ? parseInt(process.env.EVAL_TRIAL_COUNT, 10)
  : 3;

/**
 * generateSummary:
 * After all evaluations have finished, aggregate the results into a summary.
 * This summary includes:
 * - Which tasks passed or failed (with model and categories).
 * - Category-wise success percentages.
 * - Model-wise success percentages.
 *
 * The summary is written to `eval-summary.json` for further analysis.
 */
const generateSummary = async (
  results: SummaryResult[],
  experimentName: string,
) => {
  // Determine passed testcases (those with _success: true)
  const passed = results
    .filter((r) => r.output._success)
    .map((r) => ({
      eval: r.input.name,
      model: r.input.modelName,
      categories: tasksByName[r.input.name].categories,
    }));

  // Determine failed testcases (those with _success: false)
  const failed = results
    .filter((r) => !r.output._success)
    .map((r) => ({
      eval: r.input.name,
      model: r.input.modelName,
      categories: tasksByName[r.input.name].categories,
    }));

  // Calculate success counts for each category
  const categorySuccessCounts: Record<
    string,
    { total: number; success: number }
  > = {};
  for (const taskName of Object.keys(tasksByName)) {
    const taskCategories = tasksByName[taskName].categories;
    const taskResults = results.filter((r) => r.input.name === taskName);
    const successCount = taskResults.filter((r) => r.output._success).length;

    for (const cat of taskCategories) {
      if (!categorySuccessCounts[cat]) {
        categorySuccessCounts[cat] = { total: 0, success: 0 };
      }
      categorySuccessCounts[cat].total += taskResults.length;
      categorySuccessCounts[cat].success += successCount;
    }
  }

  // Compute percentage success per category
  const categories: Record<string, number> = {};
  for (const [cat, counts] of Object.entries(categorySuccessCounts)) {
    categories[cat] = Math.round((counts.success / counts.total) * 100);
  }

  // Compute percentage success per model
  const models: Record<string, number> = {};
  const allModels = [...new Set(results.map((r) => r.input.modelName))];
  for (const model of allModels) {
    const modelResults = results.filter((r) => r.input.modelName === model);
    const successCount = modelResults.filter((r) => r.output._success).length;
    models[model] = Math.round((successCount / modelResults.length) * 100);
  }

  // Format and write the summary to a JSON file
  const formattedSummary = {
    experimentName,
    passed,
    failed,
    categories,
    models,
  };

  fs.writeFileSync(
    "eval-summary.json",
    JSON.stringify(formattedSummary, null, 2),
  );
  console.log("Evaluation summary written to eval-summary.json");
};

/**
 * generateFilteredTestcases:
 * Based on the chosen filters (category or specific eval name) and environment,
 * this function generates the set of testcases to run. Each testcase is a combination
 * of a task and a model.
 *
 * Steps:
 * - Start with all combinations of tasks (from `tasksByName`) and models (`MODELS`).
 * - Filter by category if a category filter was specified.
 * - Filter by evaluation name if specified.
 * - In the BROWSERBASE environment, exclude certain tasks that are not suitable.
 */
const generateFilteredTestcases = (): Testcase[] => {
  // Create a list of all testcases for each model-task combination.
  let allTestcases = MODELS.flatMap((model) =>
    Object.keys(tasksByName).map((testName) => ({
      input: { name: testName, modelName: model },
      name: testName,
      tags: [
        model,
        testName,
        ...(tasksConfig.find((t) => t.name === testName)?.categories || []).map(
          (x) => `category/${x}`,
        ),
      ],
      metadata: {
        model,
        test: testName,
        categories: tasksConfig.find((t) => t.name === testName)?.categories,
      },
      expected: true,
    })),
  );

  // Filter test cases to match default eval categories
  allTestcases = allTestcases.filter((testcase) =>
    DEFAULT_EVAL_CATEGORIES.some((category) =>
      tasksByName[testcase.name].categories.includes(category),
    ),
  );

  // Filter by category if a category is specified
  if (filterByCategory) {
    allTestcases = allTestcases.filter((testcase) =>
      tasksByName[testcase.name].categories.includes(filterByCategory!),
    );
  }

  // Filter by a specific evaluation (task) name if specified
  if (filterByEvalName) {
    allTestcases = allTestcases.filter(
      (testcase) =>
        testcase.name === filterByEvalName ||
        testcase.input.name === filterByEvalName,
    );
  }

  // If running in BROWSERBASE environment, exclude tasks that are not applicable.
  if (env === "BROWSERBASE") {
    allTestcases = allTestcases.filter(
      (testcase) => !["peeler_simple", "stock_x"].includes(testcase.name),
    );
  }

  console.log(
    "All test cases:",
    allTestcases
      .map(
        (t, i) =>
          `${i}: ${t.name} (${t.input.modelName}): ${t.metadata.categories}`,
      )
      .join("\n"),
  );

  return allTestcases;
};

/**
 * Main execution block:
 * - Determine experiment name
 * - Determine the project name (braintrustProjectName) based on CI or dev environment
 * - Run the Eval function with the given configuration:
 *    * experimentName: A label for this run
 *    * data: A function that returns the testcases to run
 *    * task: A function that executes each task, given input specifying model and task name
 *    * scores: An array of scoring functions
 *    * maxConcurrency: Limit on parallel tasks
 *    * trialCount: Number of trials (retries) per task
 * - Collect and summarize results using `generateSummary`.
 */
(async () => {
  // Generate a unique name for the experiment
  const experimentName: string = generateExperimentName({
    evalName: filterByEvalName || undefined,
    category: filterByCategory || undefined,
    environment: env,
  });

  // Determine braintrust project name to use (stagehand in CI, stagehand-dev otherwise)
  const braintrustProjectName =
    process.env.CI === "true" ? "stagehand" : "stagehand-dev";

  try {
    // Run the evaluations with the braintrust Eval function
    const evalResult = await Eval(braintrustProjectName, {
      experimentName,
      data: generateFilteredTestcases,
      // Each test is a function that runs the corresponding task module
      task: async (input: { name: string; modelName: AvailableModel }) => {
        const logger = new EvalLogger();
        try {
          // Dynamically import the task based on its name
          const taskModulePath = path.join(
            __dirname,
            "tasks",
            `${input.name}.ts`,
          );
          const taskModule = (await import(taskModulePath)) as {
            [key: string]: EvalFunction;
          };
          const taskFunction = taskModule[input.name];

          if (typeof taskFunction !== "function") {
            throw new StagehandEvalError(
              `No Eval function found for task name: ${input.name}`,
            );
          }
          let shouldUseTextExtract = useTextExtract;
          const categories = tasksByName[input.name].categories || [];
          const isRegression = categories.includes("regression");
          const regressionExtractMethod = tasksByName[input.name].extractMethod;
          if (isRegression) {
            if (regressionExtractMethod) {
              shouldUseTextExtract = regressionExtractMethod === "textExtract";
            }
          }

          // Execute the task
          let llmClient: LLMClient;
          if (input.modelName.startsWith("gpt")) {
            llmClient = new CustomOpenAIClient({
              modelName: input.modelName as AvailableModel,
              client: wrapOpenAI(
                new OpenAI({
                  apiKey: process.env.OPENAI_API_KEY,
                }),
              ),
            });
          } else if (input.modelName.startsWith("gemini")) {
            llmClient = new AISdkClient({
              model: wrapAISDKModel(google(input.modelName)),
            });
          } else if (input.modelName.startsWith("claude")) {
            llmClient = new AISdkClient({
              model: wrapAISDKModel(anthropic(input.modelName)),
            });
          } else if (input.modelName.includes("groq")) {
            llmClient = new AISdkClient({
              model: wrapAISDKModel(
                groq(
                  input.modelName.substring(input.modelName.indexOf("/") + 1),
                ),
              ),
            });
          } else if (input.modelName.includes("cerebras")) {
            llmClient = new AISdkClient({
              model: wrapAISDKModel(
                cerebras(
                  input.modelName.substring(input.modelName.indexOf("/") + 1),
                ),
              ),
            });
          } else if (input.modelName.includes("/")) {
            llmClient = new CustomOpenAIClient({
              modelName: input.modelName as AvailableModel,
              client: wrapOpenAI(
                new OpenAI({
                  apiKey: process.env.TOGETHER_AI_API_KEY,
                  baseURL: "https://api.together.xyz/v1",
                }),
              ),
            });
          }
          const taskInput = await initStagehand({
            logger,
            llmClient,
            useTextExtract: shouldUseTextExtract,
          });
          let result;
          try {
            result = await taskFunction(taskInput);
            // Log result to console
            if (result && result._success) {
              console.log(`✅ ${input.name}: Passed`);
            } else {
              console.log(`❌ ${input.name}: Failed`);
            }
          } finally {
            await taskInput.stagehand.close();
          }
          return result;
        } catch (error) {
          // Log any errors that occur during task execution
          console.error(`❌ ${input.name}: Error - ${error}`);
          logger.error({
            message: `Error in task ${input.name}`,
            level: 0,
            auxiliary: {
              error: {
                value: error.message,
                type: "string",
              },
              trace: {
                value: error.stack,
                type: "string",
              },
            },
          });
          return {
            _success: false,
            error: JSON.parse(JSON.stringify(error, null, 2)),
            logs: logger.getLogs(),
          };
        }
      },
      // Use the scoring functions defined above
      scores: [exactMatch, errorMatch],
      maxConcurrency: MAX_CONCURRENCY,
      trialCount: TRIAL_COUNT,
    });

    // Map results to the SummaryResult format
    const summaryResults: SummaryResult[] = evalResult.results.map((result) => {
      const output =
        typeof result.output === "boolean"
          ? { _success: result.output }
          : result.output;

      return {
        input: result.input,
        output,
        name: result.input.name,
        score: output._success ? 1 : 0,
      };
    });

    // Generate and write the summary
    await generateSummary(summaryResults, experimentName);
  } catch (error) {
    console.error("Error during evaluation run:", error);
    process.exit(1);
  }
})();
