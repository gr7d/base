# Base

![Base demo](https://i.imgur.com/zJQnjoM.gif)

## ToDo
- [x] Server-side DOM comparison or write a more performant client-side function for updating the DOM
- [x] JSX-support (very basic usage)
- [ ] More clever way to handle sessions (Just cookies?)
- [ ] Find a way of handling interval functions (when to kill, etc.)

## Endpoints
Endpoints are accessible by requesting the page path + `/api/` + the endpoint name.
The endpoint functions are provided with the request object as the first argument.

## Exposures
Exposures are getting executed on the client side.

## Basic. JSX.
```typescript
import Base, { React, endpoint } from "../base.ts";

export default class Test {
    private message: string = "";

    @endpoint
    async saveMessage(message: string) {
        this.message = message;
    }

    get template() {
        return (
            <div>
                <p>You typed: {this.message}</p>
                <input
                    style={{ padding: 10 }}
                    value={this.message}
                    onKeyUp={(e: any) => this.saveMessage(e.currentTarget.value)}
                />
            </div>
        );
    }
}

const app = new Base({ port: 3000 });
app.register("/", Test);
```
