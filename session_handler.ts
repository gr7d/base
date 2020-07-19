export default class SessionHandler {
    public static getSessionID(headers: Headers) {
        // If multiple cookies with the same name exist
        const matchingCookies = headers.get("cookie")
            ?.split("; ")
            .filter(cookie => cookie.match(/base=([a-zA-Z0-9]*)/)) || [];

        return matchingCookies[matchingCookies.length - 1]?.replace("base=", "") || "";
    }
}