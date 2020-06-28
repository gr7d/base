import { Request } from "./index.ts";

export default class SessionHandler {
    public static getSessionID(headers: Headers) {
        return headers.get("cookie")
            ?.split("; ")
            .find(cookie => cookie.match(/base=([a-zA-Z0-9]*)/))
            ?.replace("base=", "") || "";
    }
}