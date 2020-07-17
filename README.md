# Base
At the moment, Base is more of a concept than a ready-to-use framework.

## Endpoints
Endpoints are accessible by requesting the page path + `/api/` + the endpoint name.
The endpoint functions are provided with the request object as the first argument.

## Exposures
Exposures are getting executed on the client side.

## Example application
```typescript
import Base, { Request } from "./index.ts";

class TestPage {
    private clicked: number = 0;

    get endpoints() {
        return {
            increaseClickCount: (req: Request) => {
                this.clicked++;
                return JSON.stringify({ success: true });
            }
        }
    }

    get exposures() {
        return {
            handleClick: async (event: Event) => {
                await fetch("api/increaseClickCount");
            }
        }
    }

    get template() {
        return `
            <button @onclick="handleClick">Click to count</button>
            <span>Clicked ${this.clicked} times</span>
        `;
    }
}

const app = new Base({ port: 3000 });
app.register("/", TestPage);
```