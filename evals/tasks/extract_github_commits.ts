import { EvalFunction } from "@/types/evals";
import { z } from "zod";

export const extract_github_commits: EvalFunction = async ({
  logger,
  useTextExtract,
  debugUrl,
  sessionUrl,
  stagehand,
}) => {
  try {
    await stagehand.page.goto("https://github.com/facebook/react");

    await stagehand.page.act({
      action:
        "find commit history, generally described by the number of commits",
    });
    const { commits } = await stagehand.page.extract({
      instruction: "Extract last 20 commits",
      schema: z.object({
        commits: z.array(
          z.object({
            commit_message: z.string(),
            commit_url: z.string(),
            commit_hash: z.string(),
          }),
        ),
      }),
      useTextExtract,
    });

    logger.log({
      message: "Extracted commits",
      level: 1,
      auxiliary: {
        commits: {
          value: JSON.stringify(commits),
          type: "object",
        },
      },
    });

    await stagehand.close();

    return {
      _success: commits.length === 20,
      commits,
      debugUrl,
      sessionUrl,
      logs: logger.getLogs(),
    };
  } catch (error) {
    console.error("Error or timeout occurred:", error);

    await stagehand.close();

    return {
      _success: false,
      error: JSON.parse(JSON.stringify(error, null, 2)),
      debugUrl,
      sessionUrl,
      logs: logger.getLogs(),
    };
  }
};
