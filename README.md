# Base
At the moment, Base is more of a concept than a ready-to-use framework.

## Endpoints
Endpoints are accessible by requesting the page path + `/api/` + the endpoint name.
The endpoint functions are provided with the request object as the first argument.

## Exposures
Exposures are getting executed on the client side.

## Example
```typescript
import Base, { Request } from "./index.ts";

class TestPage {
    get endpoints() {
        return {
            hello(req: Request) {
                return "Hi!";
            }
        }
    }

    get exposures() {
        return {
            async sayHi(event: Event) {
                const hi = await (
                    await fetch("api/hello")
                ).text();

                console.log(hi);
            }
        }
    }

    get template() {
        return `
            <button @onclick="sayHi">Say hi in the console!</button>
        `;
    }
}

const app = new Base(3000);

app.register("/", TestPage);
```