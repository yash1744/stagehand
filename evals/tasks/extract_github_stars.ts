import { EvalFunction } from "@/types/evals";
import { z } from "zod";

export const extract_github_stars: EvalFunction = async ({
  logger,
  useTextExtract,
  debugUrl,
  sessionUrl,
  stagehand,
}) => {
  try {
    await stagehand.page.goto("https://github.com/facebook/react");

    const { stars } = await stagehand.page.extract({
      instruction: "Extract the number of stars for the project",
      schema: z.object({
        stars: z.number().describe("the number of stars for the project"),
      }),
      useTextExtract,
    });

    const expectedStarsString = await stagehand.page
      .locator("#repo-stars-counter-star")
      .first()
      .innerHTML();

    const expectedStars = expectedStarsString.toLowerCase().endsWith("k")
      ? parseFloat(expectedStarsString.slice(0, -1)) * 1000
      : parseFloat(expectedStarsString);

    const tolerance = 1000;
    const isWithinTolerance = Math.abs(stars - expectedStars) <= tolerance;

    await stagehand.close();

    return {
      _success: isWithinTolerance,
      stars,
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
