import { z } from "zod";
import { EvalFunction } from "../../types/evals";

export const extract_apartments: EvalFunction = async ({
  logger,
  useTextExtract,
  debugUrl,
  sessionUrl,
  stagehand,
}) => {
  await stagehand.page.goto(
    "https://www.apartments.com/san-francisco-ca/2-bedrooms/",
  );
  const apartment_listings = await stagehand.page.extract({
    instruction:
      "Extract all the apartment listings with their prices and their addresses.",
    schema: z.object({
      listings: z.array(
        z.object({
          price: z.string().describe("The price of the listing"),
          trails: z.string().describe("The address of the listing"),
        }),
      ),
    }),
    useTextExtract,
  });

  await stagehand.close();
  const listings = apartment_listings.listings;
  const expectedLength = 40;

  if (listings.length < expectedLength) {
    logger.error({
      message: "Incorrect number of listings extracted",
      level: 0,
      auxiliary: {
        expected: {
          value: expectedLength.toString(),
          type: "integer",
        },
        actual: {
          value: listings.length.toString(),
          type: "integer",
        },
      },
    });
    return {
      _success: false,
      error: "Incorrect number of listings extracted",
      logs: logger.getLogs(),
      debugUrl,
      sessionUrl,
    };
  }

  return {
    _success: true,
    logs: logger.getLogs(),
    debugUrl,
    sessionUrl,
  };
};
