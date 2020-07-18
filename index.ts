import { serve, serveTLS, Server, ServerRequest, Response as ServerResponse, HTTPOptions, HTTPSOptions } from "https://deno.land/std@v0.61.0/http/server.ts";
import { acceptWebSocket, WebSocket } from "https://deno.land/std@v0.61.0/ws/mod.ts";
import SessionHandler from "./session_handler.ts";

export type Request = ServerRequest;

interface UninitializedPage {
    new(storage: any): Page;
}

interface Page {
    endpoints?: { [name: string]: (req: Request) => void | string; };
    exposures?: { [name: string]: any; };
    template: string;
}

interface UnfixedPage extends Page {
    [key: string]: any;
}

interface SessionPage extends Page {
    _lastServedRawHTML: string;
}

export interface Storage {
    get(name: string): any;
    update(name: string, value: any): void;
    create(name: string, defaultValue: any): void;
}

export class Session {
    private readonly _id: string;
    private _pages: { [path: string]: SessionPage; } = {};
    public _storage: { pagePathThatModifiedThisEntry: string[]; name: string; value: any; }[] = [];
    public currentPagePath: string | null = null;

    constructor(id: string) {
        this._id = id;
    }

    get storage() {
        return {
            get: (name: string) => {
                return this._storage.find(entry => entry.name === name)?.value ?? null;
            },
            update: async (name: string, handler: (currentValue: any) => any) => {
                if (!this._storage.find(entry => entry.name === name)) {
                    return;
                }

                const entry = this._storage.find(entry => entry.name === name) as { pagePathThatModifiedThisEntry: string[]; name: string; value: any; };
                entry!.value = await handler(entry?.value);

                if (this.currentPagePath && !entry.pagePathThatModifiedThisEntry.includes(this.currentPagePath)) {
                    entry.pagePathThatModifiedThisEntry.push(this.currentPagePath);
                }
            },
            create: (name: string, defaultValue: any) => {
                if (this._storage.find(entry => entry.name === name)) {
                    return;
                }

                this._storage.push({ pagePathThatModifiedThisEntry: this.currentPagePath ? [ this.currentPagePath ] : [], name, value: defaultValue });
            }
        }
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
    private decoder: TextDecoder;

    constructor(options: HTTPOptions | HTTPSOptions) {
        this.decoder = new TextDecoder();
        this.server = (options as HTTPSOptions).keyFile
            ? serveTLS({ ...(options as HTTPSOptions) })
            : serve({ ...options  });
        this.handleRequests();
    }

    private getSessionPage(path: string, parameters: URLSearchParams, session: Session): SessionPage {
        if (!session.pages[path] && this.pages[path]) {
            session._storage = session._storage.filter(entry => !entry.pagePathThatModifiedThisEntry.includes(path));

            let temporaryPage: UnfixedPage = new this.pages[path](session.storage);
            temporaryPage._lastServedHTML = "";

            const sessionPage = temporaryPage as SessionPage;
            session.addPage(path, sessionPage);
        }

        return session.pages[path];
    }

    private generateClientApp(exposures: { [name: string]: any; }) {
        return JSON.stringify(Object.keys(exposures).reduce((clientApp: { [name: string]: any; }, exposure) => {
            const type = typeof exposures[exposure] === "function" ? "function" : "value";
            const value = type === "function" ? exposures[exposure].toString() : exposures[exposure];

            return {
                ...clientApp,
                [exposure]: {
                    type,
                    value: value.replace(/this.exposures./g, "app.")
                }
            }
        }, {}));
    }

    private addUsefulHeadTagsAndDoctype(template: string): string {
        const templateWithoutHead = template.replace(/<(|\/)head.*?>/g, "");
        const htmlTag = template.match(/<html(.|\n)*?>/gm)?.[0] || "<html lang='en'>";

        return `
            ${htmlTag}
            <!DOCTYPE html>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            ${templateWithoutHead.replace(/<html(.|\n)*?>/, "")}
        `;
    }

    private parseTemplate(template: string, exposures: { [name: string]: any; } = {}): string {
        const clientApp = this.generateClientApp(exposures);
        const injectionScript = `<script>
            const app = JSON.parse(${JSON.stringify(clientApp)});
            Object.keys(app).forEach(function(exposure) {
                if (app[exposure].type === "function") {
                    eval("var temp = {" + (app[exposure].value.trimLeft().match(new RegExp(exposure + "\(.*?\).*?{")) ? app[exposure].value : exposure + ":" + app[exposure].value) + "}");
                    app[exposure] = temp[exposure];
                }else {
                    app[exposure] = app[exposure].value;
                }
                
                if (exposure.startsWith("on") && window[exposure] !== undefined) {
                    window[exposure] = app[exposure];
                }
            });
            
            function bindEventListeners() {
                document.querySelectorAll("[data-on]").forEach(bindedElement => {
                    bindedElement.addEventListener(bindedElement.getAttribute("data-on"), app[bindedElement.getAttribute("data-handler")]);
                });
            }
            
            function uniquifyElement(element) {
                return element.outerHTML.match(/<((.|\\n)*?)>/g)[0] + (element.parentElement ? element.parentElement.outerHTML.match(/<((.|\\n)*?)>/g)[0] + element.parentElement.children.length : "");
            }
            
            const ws = new WebSocket("ws" + (document.location.protocol.includes("https") ? "s://" : "://") + document.location.hostname + (document.location.port.length > 1 ? ":" + document.location.port : "") + document.location.pathname + "/socket");
            ws.onmessage = function(event) {
                const [type, content] = event.data.split("[t--c]");
                
                switch (type) {
                    case "update_content":
                        const temp = document.createElement("html");
                        temp.innerHTML = content;
                        const tempElements = Array.from(temp.querySelectorAll("body *:not(script):not(img)"));
                        const elements = Array.from(document.body.querySelectorAll("*:not(script):not(img)"));
                        
                        const t = tempElements.reduce((tempElements, tempElement) => {
                            if (
                                elements.find(element => element.isEqualNode(tempElement))
                                || tempElements.find(tempElementInList => tempElementInList.isEqualNode(tempElement))
                            ) {
                                return tempElements;
                            }
                            
                            return [
                                ...tempElements,
                                tempElement
                            ];
                        }, []);                        

                        for (const tempElement of t) {
                            let deepestChildrenThatDontExistInDocument = Array.from(tempElement.children).filter(child => !elements.find(element => element.isEqualNode(child)) && elements.find(element => uniquifyElement(element) === uniquifyElement(child)));
                           
                            while (true) {
                                if (deepestChildrenThatDontExistInDocument.filter(r => Array.from(r.children).filter(child => !elements.find(element => element.isEqualNode(child)) && elements.find(element => uniquifyElement(element) === uniquifyElement(child))).length > 0).length === 0)
                                    break;
                               
                                for (let i = 0; i < deepestChildrenThatDontExistInDocument.length; i++) {
                                    const deepestChildThatDontExistInDocument = deepestChildrenThatDontExistInDocument[i];

                                    if (!deepestChildThatDontExistInDocument.children) continue;
                                    const c = Array.from(deepestChildThatDontExistInDocument.children).filter(child => !elements.find(element => element.isEqualNode(child)) && elements.find(element => uniquifyElement(element) === uniquifyElement(child)));

                                    if (c.length > 0) {
                                        deepestChildrenThatDontExistInDocument.splice(i, 1);
                                        deepestChildrenThatDontExistInDocument.push(...c);
                                    }
                                }
                            }
                           
                           
                            for (const childThatDontExistInDocument of deepestChildrenThatDontExistInDocument) {
                                const matchingChildInDocument = elements.find(element => uniquifyElement(element) === uniquifyElement(childThatDontExistInDocument));
                               
                                if (!matchingChildInDocument) return;
                                matchingChildInDocument.innerHTML = childThatDontExistInDocument.innerHTML;
                            }
                        }
                        
                        bindEventListeners();
                        break;
                }
            }
            
            bindEventListeners();
        </script>`;

        const templateWithValidAttributes = template.replace(/@on(.*?)\=/g, `data-on="$1" data-handler=`);
        const templateWithUsefulInformation = this.addUsefulHeadTagsAndDoctype(templateWithValidAttributes);
        return templateWithUsefulInformation + injectionScript;
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

    private async handleWebSocketRequest(req: Request, parameters: URLSearchParams, session: Session, conn: any, bufReader: any, bufWriter: any, headers: Headers) {
        const { pathname: pagePath } = new URL("http://localhost" + req.url.replace("/socket", ""));
        const page = this.getSessionPage(pagePath, parameters, session);

        if (!page) {
            req.respond({ body: "Could not setup socket connection." });
            return;
        }

        try {
            await this.handleWebSocketConnection(await acceptWebSocket({ conn, bufReader, bufWriter, headers }), page);
        }catch {
            req.respond({ body: "Could not setup socket connection." });
        }
    }

    private getSession(req: Request, res: any, path: string): Session {
        // const cookies = req.headers.get("cookie");
        //
        // if (!this.sessions[path + JSON.stringify(cookies)]) {
        //     return this.sessions[path + JSON.stringify(cookies)] = new Session(path + JSON.stringify(cookies));
        // }
        //
        // return this.sessions[path + JSON.stringify(cookies)];

        let sessionID: string = SessionHandler.getSessionID(req.headers);

        if (!sessionID || !this.sessions[sessionID]) {
            const newSessionID = String(Math.floor(Math.random() * 1e16).toString(32));
            res.headers!.append("Set-Cookie", `base=${newSessionID}`);
            this.sessions[newSessionID] = new Session(newSessionID);
            sessionID = newSessionID;
        }

        return this.sessions[sessionID];
    }

    private async handleEndpointRequest(req: Request, path: string, parameters: URLSearchParams, session: Session) {
        const { pathname: pagePath } = new URL("http://localhost" + (req.url.replace(/\/api(.*)/, "") === "" ? "/" : req.url.replace(/\/api(.*)/, "")));
        const page = this.getSessionPage(pagePath, parameters, session);

        if (!page) {
            req.respond({ body: "Endpoint does not exist." });
            return;
        }

        const endpoint = new URL("http://localhost" + req.url.replace(/.*api(?=\/)/, "")).pathname.replace(/^\//, "");

        if (!page.endpoints?.[endpoint]) {
            req.respond({ body: "Endpoint does not exist." });
            return;
        }

        req.respond({ body: await page.endpoints?.[endpoint](req) || "" });
    }

    private async handlePublicResourceRequest(req: Request, path: string) {
        const resource = path.replace(/.*\/(?=public\/)/, "");

        try {
            req.respond({ body: await Deno.readFile(resource) });
        }catch (error) {
            if ((error as Error).name === "PermissionDenied") {
                // throw Error("Couldn't")
            }
            req.respond({ status: 404, body: "File not found." });
        }
    }

    private async handleRequests() {
        for await (const req of this.server) {
            const res = { headers: new Headers(), body: "No page found, yo!" };
            const { pathname: path, searchParams: parameters } = new URL("http://localhost" + req.url);
            const session: Session = this.getSession(req, res, path);

            if (req.url.endsWith("/socket")) {
                await this.handleWebSocketRequest(req, parameters, session, req.conn, req.r, req.w, req.headers);
                continue;
            }

            if (req.url.includes("/api/")) {
                await this.handleEndpointRequest(req, path, parameters, session);
                continue;
            }

            if (req.url.includes("/public/")) {
                await this.handlePublicResourceRequest(req, path);
                continue;
            }

            const page: SessionPage = this.getSessionPage(path, parameters, session);
            res.headers.append("Content-Type", "text/html");

            if (page?.template) {
                page._lastServedRawHTML = page.template;
                session.currentPagePath = path;
                res.body = this.parseTemplate(page.template, page.exposures);
            }

            req.respond(res);
        }
    }

    public register(path: string, page: UninitializedPage) {
        this.pages[path] = page;
    }

    public killSessions() {
        this.sessions = {};
    }
}