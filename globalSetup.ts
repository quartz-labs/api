import { App } from "./src/app.ts";
import { DataRoute } from "./src/routes/data.route";
import { UserRoute } from "./src/routes/user.route";
import { ProgramRoute } from "./src/routes/program.route";
export default async () => {
      const app = new App([
            new ProgramRoute(),
            new DataRoute(),
            new UserRoute(),
      ]);
      await app.listen();
};
