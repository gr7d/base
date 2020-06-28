import { serve, Server, ServerRequest, Response as ServerResponse } from "https://deno.land/std@v0.42.0/http/server.ts";
import { acceptWebSocket, WebSocket } from "https://deno.land/std@v0.42.0/ws/mod.ts";
import SessionHandler from "./session_handler.ts";

export type Request = ServerRequest;

interface UninitializedPage {
    new(session: Session): Page;
}

interface Page {
    endpoints?: { [name: string]: (req: Request) => string; };
    exposures?: { [name: string]: any; };
    template: string;
}

interface UnfixedPage extends Page {
    [key: string]: any;
}

interface SessionPage extends Page {
    _lastServedRawHTML: string;
}

class Session {
    private readonly _id: string;
    private _pages: { [path: string]: SessionPage; } = {};
    public storage: { [key: string]: any; } = {};

    constructor(id: string) {
        this._id = id;
    }

    get id() {
        return this._id;
    }

    get pages() {
        return this._pages;
    }

    public addPage(path: string, page: SessionPage) {
        this._pages[path] = page;
    }
}

export default class Base {
    private readonly server: Server;
    private pages: { [path: string]: UninitializedPage } = {};
    private sessions: { [id: string]: Session } = {};

    constructor(port: number) {
        this.server = serve({ port });
        this.handleRequests();
    }

    private getSessionPage(path: string, session: Session): SessionPage {
        if (!session.pages[path] && this.pages[path]) {
            let temporaryPage: UnfixedPage = new this.pages[path](session);
            temporaryPage._lastServedHTML = "";

            const sessionPage = temporaryPage as SessionPage;
            session.addPage(path, sessionPage);
        }

        return session.pages[path];
    }

    private generateClientApp(exposures: { [name: string]: any; }) {
        return JSON.stringify(Object.keys(exposures).reduce((clientApp: { [name: string]: any; }, exposure) => {
            const type = typeof exposures[exposure] === "function" ? "function" : "value";

            return {
                ...clientApp,
                [exposure]: {
                    type,
                    value: type === "function" ? exposures[exposure].toString() : exposures[exposure]
                }
            }
        }, {}));
    }

    private parseTemplate(template: string, exposures: { [name: string]: any; } = {}): string {
        const clientApp = this.generateClientApp(exposures);
        const injectionScript = `<script>
            const app = JSON.parse(${JSON.stringify(clientApp)});
            Object.keys(app).forEach(function(exposure) {
                if (app[exposure].type === "function") {
                    eval("var temp = {" + (app[exposure].value.includes(exposure + "(") ? app[exposure].value : exposure + ":" + app[exposure].value) + "}");
                    app[exposure] = temp[exposure];
                }else {
                    app[exposure] = app[exposure].value;
                }
            });

            function bindEventListeners() {
                document.querySelectorAll("[data-on]").forEach(bindedElement => {
                    bindedElement.addEventListener(bindedElement.getAttribute("data-on"), app[bindedElement.getAttribute("data-handler")]);
                });
            }
            
            const ws = new WebSocket(document.location.href.replace(/https|http/, "ws") + "/socket");
            ws.onmessage = function(event) {
                const [type, content] = event.data.split("[t--c]");
                
                switch (type) {
                    case "update_content":
                        document.body.innerHTML = content;
                        bindEventListeners();
                        break;
                }
            }
            
            bindEventListeners();
        </script>`;

        const templateWithValidAttributes = template.replace(/@on(.*?)\=/, `data-on="$1" data-handler=`);
        return templateWithValidAttributes + injectionScript;
    }

    private async handleWebSocketConnection(socket: WebSocket, page: SessionPage) {
        let lastRenderedHTML = page._lastServedRawHTML;

        const contentUpdater = setInterval(async () => {
            const currentRenderedHTML = page.template;
            if (currentRenderedHTML !== lastRenderedHTML) {
                lastRenderedHTML = currentRenderedHTML;

                try {
                    await socket.send(`update_content[t--c]${this.parseTemplate(page.template, page.exposures)}`);
                }catch {
                    clearInterval(contentUpdater);
                    socket.closeForce();
                }
            }
        }, 50);
    }

    private async handleWebSocketRequest(path: string, session: Session, conn: any, bufReader: any, bufWriter: any, headers: Headers) {
        const pagePath = path.replace("/socket", "");
        const page = this.getSessionPage(pagePath, session);

        if (!page) {
            return;
        }

        await this.handleWebSocketConnection(await acceptWebSocket({ conn, bufReader, bufWriter, headers }), page);
    }

    private getSession(req: Request, res: ServerResponse) {
        let sessionID: string = SessionHandler.getSessionID(req.headers);

        if (!sessionID || !this.sessions[sessionID]) {
            const newSessionID = String(Math.floor(Math.random() * 1e16).toString(32));
            res.headers!.append("Set-Cookie", `base=${newSessionID}`);
            this.sessions[newSessionID] = new Session(newSessionID);
            sessionID = newSessionID;
        }

        return this.sessions[sessionID];
    }

    private async handleEndpointRequest(req: Request, path: string, session: Session) {
        const pagePath = path.replace(/\/api(.*)/, "") === "" ? "/" : path.replace(/\/api(.*)/, "");
        const page = this.getSessionPage(pagePath, session);

        if (!page) {
            return;
        }

        const endpoint = path.replace(/.*api\//, "");

        if (!page.endpoints?.[endpoint]) {
            req.respond({ body: "Endpoint does not exist." });
            return;
        }

        req.respond({ body: await page.endpoints?.[endpoint](req) || "" });
    }

    private async handleRequests() {
        for await (const req of this.server) {
            const res = { headers: new Headers(), body: "No page found, yo!" };
            const session = this.getSession(req, res);
            const path = new URL("http://localhost" + req.url).pathname;

            if (path.endsWith("/socket")) {
                await this.handleWebSocketRequest(path, session, req.conn, req.r, req.w, req.headers);
                continue;
            }

            if (path.includes("/api/")) {
                await this.handleEndpointRequest(req, path, session);
                continue;
            }

            const page = this.getSessionPage(path, session);
            res.headers.append("Content-Type", "text/html");

            if (page?.template) {
                page._lastServedRawHTML = page.template;
                res.body = this.parseTemplate(page.template, page.exposures);
            }

            req.respond(res);
        }
    }

    public register(path: string, page: UninitializedPage) {
        this.pages[path] = page;
    }
}