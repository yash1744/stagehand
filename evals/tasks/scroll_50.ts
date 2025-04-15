import { EvalFunction } from "@/types/evals";

export const scroll_50: EvalFunction = async ({
  debugUrl,
  sessionUrl,
  stagehand,
  logger,
}) => {
  await stagehand.page.goto(
    "https://browserbase.github.io/stagehand-eval-sites/sites/aigrant/",
  );
  await stagehand.page.act({
    action: "Scroll 50% down the page",
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Get the current scroll position and total scroll height
  const scrollInfo = await stagehand.page.evaluate(() => {
    return {
      scrollTop: window.scrollY + window.innerHeight / 2,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });

  await stagehand.close();

  const halfwayScroll = scrollInfo.scrollHeight / 2;
  const halfwayReached = Math.abs(scrollInfo.scrollTop - halfwayScroll) <= 200;
  const evaluationResult = halfwayReached
    ? {
        _success: true,
        logs: logger.getLogs(),
        debugUrl,
        sessionUrl,
      }
    : {
        _success: false,
        logs: logger.getLogs(),
        debugUrl,
        sessionUrl,
        message: `Scroll position (${scrollInfo.scrollTop}px) is not halfway down the page (${halfwayScroll}px).`,
      };

  return evaluationResult;
};
