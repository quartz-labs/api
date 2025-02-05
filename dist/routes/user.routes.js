import { Router } from "express";
import { UserController } from "../controllers/user.controller.js";
export class UserRoute {
    path = "/user";
    router = Router();
    userController = new UserController();
    constructor() {
        this.initializeRoutes();
    }
    initializeRoutes() {
        this.router.get("/rate", this.userController.getRate);
        this.router.get("/balance", this.userController.getBalance);
        this.router.get("/withdraw-limit", this.userController.getWithdrawLimit);
        this.router.get("/health", this.userController.getHealth);
    }
}
//# sourceMappingURL=user.routes.js.map