// Import the HTTP module
const Http = require("http");
const Fs = require('fs');
// Puppeteer is a Node.js library which provides a high-level API to control Chrome/Chromium over the DevTools Protocol.
// const Puppeteer = require("puppeteer");
const Puppeteer = require("puppeteer-extra");
// A puppeteer-extra and playwright-extra plugin to solve reCAPTCHAs and hCaptchas automatically.
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
// Zod is TypeScript-first schema validation with static type inference.
const Zod = require("zod");
// Axios is a promise based HTTP client for the browser and node.js
const Axios = require("axios");
// Dotenv is a zero-dependency module that loads environment variables from a .env file into process.env.
require('dotenv').config();

// Server config
const hostname = process.env.SERVER_HOSTNAME;
const port = process.env.SERVER_PORT;
const serverUrl = `http://${hostname}:${port}/`;

// Pupeteer goto timeout
const timeout = parseInt(process.env.PUPPETEER_TIMEOUT) * 1000; // in milliseconds
const puppeteerProxy = process.env.PUPPETEER_PROXY;
const puppeteerUserAgent = process.env.PUPPETEER_AGENT;
const puppeteerLunchOptions = {
    headless: true, // true
    args: [
        // '--no-sandbox',
        // '--headless',
        // '--disable-gpu',
        // `--proxy-server=${puppeteerProxy}`,
        // '--disable-setuid-sandbox',
        // '--disable-web-security',
        // '--disable-features=IsolateOrigins,site-per-process',
    ]
}; // in milliseconds

const apiUrl = process.env.NODE_ENV == 'production'
    ? `https://mobapi.slick-pay.com/`
    : 'http://127.0.0.1:8000/';
const restrictIp = process.env.SERVER_IP_FILTER == 'true' ? true : false;
const allowedIp = process.env.SERVER_ALLOWED_IPS.split(',');
// Must be specified in requests as a value for "x-slickpay" header
const authToken = process.env.SERVER_AUTH_TOKEN;

// 2captcha API Key
const captchaApiKey = process.env.API_2CAPTCHA_KEY;
// 2captcha delay
const delay = parseInt(process.env.API_2CAPTCHA_DEPLAY) * 1000; // in milliseconds

// Services Url's
const services = {
    sonelgaz: `https://epayement.elit.dz/payementFacture.xhtml`,
    seaal: `https://fatourati.seaal.dz`
}

// Make our HTTP server
const server = Http.createServer(async (request, response) => {

    // Restrict the access only with the POST method
    if (request.method != "POST") {
        response.writeHead(302, {
            'Location': process.env.SERVER_DEFAULT_REDIRECT
        });
        response.end();
    } else {
        let data = "";

        // Auth Token required + Client IP restriction
        if (
            request.headers[process.env.SERVER_AUTH_HEADER] == authToken
            && (
                (
                    restrictIp
                    && [...[`127.0.0.1`], ...allowedIp].includes(request.socket.remoteAddress)
                )
                || !restrictIp
            )
        ) {
            // A chunk of data has been recieved.
            request.on("data", chunk => {
                data += chunk;
            });

            // The whole response has been received. Print out the result.
            request.on("end", async () => {
                let postData = JSON.parse(data);
                let browser = null;

                try {
                    const zodSchema = Zod.object({
                        action: Zod.enum(["otp"]).optional(),
                        service: Zod.enum(["sonelgaz", "seaal"]).optional(),
                    });
                    zodSchema.parse(postData);

                    const timestamp = (new Date()).getTime();

                    switch (postData.service) {

                        case 'sonelgaz': {

                            try {

                                const zodSchema = Zod.object({
                                    facture: Zod.union([Zod.string(), Zod.number().positive()]),
                                    montant: Zod.union([Zod.string(), Zod.number().positive()]),
                                    cle: Zod.union([Zod.string(), Zod.number().positive()]),
                                });
                                zodSchema.parse(postData);

                                // Lunch Browser using Puppeteer
                                browser = await Puppeteer.launch(puppeteerLunchOptions);
                                const page = await browser.newPage();

                                await page.setUserAgent(puppeteerUserAgent);

                                const pupRes = await page.goto(services.sonelgaz, { waitUntil: 'networkidle0' });

                                if (pupRes.status() != 200) {
                                    await browser.close();

                                    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: await page.title() }));
                                } else {
                                    await page.waitForSelector('#formprin', { timeout: timeout });

                                    await page.type('[id="formprin:facture"]', String(postData.facture));
                                    await page.type('[id="formprin:montant"]', String(postData.montant.replace(',', '.')));
                                    await page.type('[id="formprin:cle"]', String(postData.cle));

                                    await page.click('.form-holder button[type="submit"]', { waitUntil: 'networkidle0' });

                                    await page.waitForSelector('#formprin', { timeout: timeout });

                                    if (await page.$('[class="ui-messages-error-summary"]') !== null) {
                                        const element = await page.$('[class="ui-messages-error-summary"]');
                                        const text = await page.evaluate(element => element.innerText, element);

                                        await browser.close();

                                        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: text }));
                                    } else {
                                        await page.waitForSelector('#faceletsExampleCaptcha_CaptchaImage', { timeout: timeout });

                                        let satimUrl = null;
                                        let iterate = true;
                                        let resend = null;

                                        let captchaIn = null;
                                        let captchaRes = null;

                                        let errorMessage = false;

                                        const captchaPath = `screenshots/${timestamp}.png`;

                                        while (satimUrl == null && iterate) {

                                            if (resend == null) {
                                                let captcha = await page.$('#faceletsExampleCaptcha_CaptchaImage');
                                                await captcha.screenshot({
                                                    'path': captchaPath,
                                                    'type': 'png'
                                                });

                                                let base64 = `data:image/png;base64,` + Fs.readFileSync(captchaPath, 'base64');

                                                captchaIn = await Axios.post('https://2captcha.com/in.php', {
                                                    "key": captchaApiKey,
                                                    "method": "base64",
                                                    "body": base64,
                                                    "min_len": 6,
                                                    "max_len": 6,
                                                    "json": 1
                                                }, {
                                                    headers: {
                                                        'Accept': 'application/json',
                                                        'Content-Type': 'application/json'
                                                    }
                                                });
                                            } else {
                                                captchaIn = resend;
                                                resend = null;
                                            }

                                            if (captchaIn.data.status == 1) {
                                                await new Promise(resolve => setTimeout(resolve, delay));

                                                captchaRes = await Axios.get(`https://2captcha.com/res.php?action=get&json=1&key=${captchaApiKey}&id=${captchaIn.data.request}`, {
                                                    headers: {
                                                        'Accept': 'application/json',
                                                        'Content-Type': 'application/json'
                                                    }
                                                });

                                                if (captchaRes.data.status == 1) {
                                                    await page.$eval('.modalite-check input[type="checkbox"]', el => el.click());

                                                    await page.type('[id="formprin:id"]', String(captchaRes.data.request));

                                                    await page.click('.ui-commandlink', { waitUntil: 'networkidle2' });

                                                    await new Promise(resolve => setTimeout(resolve, 1 * 1000)); // Wait for image captcha to load, because we are using waitUntil: networkidle2 instead of networkidle0

                                                    let nextStep = new URL(page.url()).hostname;

                                                    if (nextStep == 'cib.satim.dz') {
                                                        satimUrl = page.url();
                                                        iterate = false;
                                                    }
                                                } else {
                                                    errorMessage = '2captcha error' + captchaRes.data.request ? `: ${captchaRes.data.request}` : '';

                                                    if ([
                                                        'ERROR_WRONG_USER_KEY',
                                                        'ERROR_TOKEN_EXPIRED',
                                                    ].includes(captchaRes.data.request)) {
                                                        iterate = false;
                                                    } else if ('CAPCHA_NOT_READY') {
                                                        await new Promise(resolve => setTimeout(resolve, 5 * 1000)); // 2captcha doc: Make 5 seconds timeout and repeat your request

                                                        resend = captchaIn;
                                                    }
                                                }

                                            } else {
                                                errorMessage = '2captcha error' + captchaIn.data.request ? `: ${captchaIn.data.request}` : '';

                                                if ([
                                                    'ERROR_WRONG_USER_KEY',
                                                    'ERROR_KEY_DOES_NOT_EXIST',
                                                    'ERROR_ZERO_BALANCE',
                                                    'ERROR_PAGEURL',
                                                    'ERROR_NO_SLOT_AVAILABLE',
                                                    'ERROR_BAD_PARAMETERS',
                                                ].includes(captchaIn.data.request)) iterate = false;
                                            }
                                        }

                                        Fs.unlinkSync(captchaPath);

                                        await browser.close();

                                        if (satimUrl) {
                                            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 1, error: 0, status: 200, url: satimUrl }));
                                        } else if (errorMessage) {
                                            response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: errorMessage }));
                                        } else {
                                            response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: "Server error" }));
                                        }
                                    }

                                }

                            } catch (error) {

                                if (!!browser) await browser.close();

                                if (error instanceof Zod.ZodError) {
                                    response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 422, messages: error.issues }));
                                } else {
                                    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                                }
                            }

                            break;
                        }

                        case 'seaal': {

                            try {
                                const zodSchema = Zod.object({
                                    code: Zod.string(),
                                });
                                zodSchema.parse(postData);

                                Puppeteer.use(
                                    RecaptchaPlugin({
                                        provider: {
                                            id: '2captcha',
                                            token: captchaApiKey // REPLACE THIS WITH YOUR OWN 2CAPTCHA API KEY ⚡
                                        },
                                        visualFeedback: true // colorize reCAPTCHAs (violet = detected, green = solved)
                                    })
                                )

                                // Lunch Browser using Puppeteer
                                browser = await Puppeteer.launch(puppeteerLunchOptions);
                                const page = await browser.newPage();

                                await page.setUserAgent(puppeteerUserAgent);

                                const pupRes = await page.goto(services.seaal, { waitUntil: 'networkidle0' });

                                if (pupRes.status() != 200) {
                                    await browser.close();

                                    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: await page.title() }));
                                } else {
                                    await page.waitForSelector('#myform', { timeout: timeout });

                                    const codes = postData.code.split(' ');

                                    await page.type('[id="code0"]', String(codes[0]));
                                    await page.type('[id="code1"]', String(codes[1]));
                                    await page.type('[id="code2"]', String(codes[2]));
                                    await page.type('[id="code3"]', String(codes[3]));

                                    await page.click('.btndiv .center-div a:last-child', { waitUntil: 'networkidle0' });

                                    await page.waitForSelector('#myform', { timeout: timeout });

                                    if (await page.$('.alert.alert-danger') !== null) {
                                        const element = await page.$('.alert.alert-danger strong');
                                        const text = await page.evaluate(element => element.innerText, element);

                                        await browser.close();

                                        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: text.substring(1, text.length-1) }));
                                    } else {

                                        for (const frame of page.mainFrame().childFrames()) {
                                            const { captchas, solutions, solved, error } = await frame.solveRecaptchas();

                                            console.log('captchas', captchas);
                                            console.log('solutions', solutions);
                                            console.log('solved', solved);
                                            console.log('error', error);
                                        }

                                        await page.$eval('#checkbox', el => el.click());

                                        await Promise.all([
                                            page.waitForNavigation(),
                                            page.click(`.button-group a:first-child`, { waitUntil: 'networkidle2' })
                                        ]);
                                    }
                                }

                            } catch (error) {

                                // if (!!browser) await browser.close();

                                if (error instanceof Zod.ZodError) {
                                    response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 422, messages: error.issues }));
                                } else {
                                    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                                }
                            }

                            break;
                        }

                        // SATIM
                        default: {

                            // Routing
                            switch (postData.action) {

                                case 'otp': {
                                    let otpUrl;

                                    try {

                                        const zodSchema = Zod.object({
                                            url: Zod.string().url(),
                                            otp: Zod.string().min(5),
                                            invoice: z.nullable(),
                                        });
                                        zodSchema.parse(postData);

                                        // Lunch Browser using Puppeteer
                                        browser = await Puppeteer.launch(puppeteerLunchOptions);
                                        const page = await browser.newPage();

                                        await page.setUserAgent(puppeteerUserAgent);

                                        const pupRes = await page.goto(postData.url, { waitUntil: 'networkidle2' });

                                        if (pupRes.status() != 200) {
                                            await browser.close();

                                            response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: await page.title() }));
                                        } else {
                                            await page.waitForSelector('#authForm', { timeout: timeout });

                                            otpUrl = new URL(page.url()).hostname;

                                            if (otpUrl == 'epay.poste.dz') {
                                                await page.type('#pwdInputVisible', String(postData.otp));
                                            } else { // acs.satim.dz
                                                await page.type('#pwdInputMasked', String(postData.otp));
                                            }

                                            await page.click('#submitPasswordButton', { waitUntil: 'networkidle2' });

                                            await new Promise(resolve => setTimeout(resolve, delay));

                                            if (await page.$('[class="errorMessage"]') !== null) {
                                                const element = await page.$('[class="errorMessage"]');
                                                const text = await page.evaluate(element => element.innerText, element);

                                                await browser.close();

                                                response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: text, url: postData.url }));
                                            } else {

                                                otpUrl = page.url();
                                                const redirect = new URL(page.url()).hostname;

                                                if (
                                                    postData.invoice
                                                    && redirect == 'epayement.elit.dz'
                                                    && await page.$('[class="logo-text"]') !== null
                                                ) {
                                                    const element = await page.$('[class="logo-text"]');
                                                    const text = await page.evaluate(element => element.innerText, element);

                                                    if (text.includes('Gaz')) {
                                                        let element = await page.$('table[width="80%"] tr:nth-child(2) table[width="100%"] tr:nth-child(2) td:nth-child(1)');
                                                        let operation = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(2) table[width="100%"] tr:nth-child(2) td:nth-child(2)');
                                                        let transaction = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(2) table tr:nth-child(2) td:nth-child(3)');
                                                        let auth = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(5) table tr:nth-child(2) td:nth-child(1)');
                                                        let invoice = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(5) table tr:nth-child(2) td:nth-child(2)');
                                                        let amount = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(5) table tr:nth-child(2) td:nth-child(3)');
                                                        let ebb = await page.evaluate(element => element.innerText, element);

                                                        element = await page.$('table[width="80%"] tr:nth-child(5) table tr:nth-child(2) td:nth-child(4)');
                                                        let date = await page.evaluate(element => element.innerText, element);

                                                        await page.addStyleTag({content: '#form1 .form-group .col-sm-12 { display: none; }'});

                                                        // Downlaod the PDF
                                                        const pdf = await page.pdf({
                                                            path: `${__dirname}/invoices/${postData.invoice}.pdf`,
                                                            margin: { top: '100px', right: '50px', bottom: '100px', left: '50px' },
                                                            printBackground: true,
                                                            format: 'A4',
                                                        });

                                                        let res = await Axios.post(`${apiUrl}api/puppeteer/meta/${postData.invoice}`, {
                                                            operation: operation,
                                                            transaction: transaction,
                                                            auth: auth,
                                                            invoice: invoice,
                                                            amount: amount,
                                                            ebb: ebb,
                                                            date: date,
                                                            file: `${serverUrl}/invoices/${postData.invoice}.pdf`,
                                                        }, {
                                                            headers: {
                                                                'Accept': 'application/json',
                                                                'Content-Type': 'application/json'
                                                            }
                                                        });

                                                    }
                                                }

                                                await browser.close();

                                                response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 1, error: 0, status: 200, url: otpUrl }));
                                            }
                                        }

                                    } catch (error) {

                                        if (!!browser) await browser.close();

                                        if (error instanceof Zod.ZodError) {
                                            response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 422, messages: error.issues }));
                                        } else {
                                            response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                                        }
                                    }

                                    break;
                                }

                                default: {
                                    let otpUrl;

                                    // Step 1: Card data
                                    try {

                                        // Post data validation
                                        const zodSchema = Zod.object({
                                            url: Zod.string().url(),
                                            iPAN: Zod.string().min(12),
                                            iCVC: Zod.string().min(3),
                                            month: Zod.string().length(2),
                                            year: Zod.string().length(4),
                                            iTEXT: Zod.string().min(3),
                                        });
                                        zodSchema.parse(postData);

                                        // Lunch Browser using Puppeteer
                                        browser = await Puppeteer.launch(puppeteerLunchOptions);

                                        const page = await browser.newPage();

                                        await page.setUserAgent(puppeteerUserAgent);

                                        const pupRes = await page.goto(postData.url, { waitUntil: 'networkidle2' });

                                        if (pupRes.status() == 403) {
                                            await browser.close();

                                            response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: 'SATIM Url expired' }));
                                        } else if (pupRes.status() != 200) {
                                            await browser.close();

                                            response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: pupRes.status(), message: await page.title() }));
                                        } else {
                                            await page.waitForSelector('#formPayment', { timeout: timeout });

                                            await page.type('#iPAN', String(postData.iPAN));
                                            await page.type('#iCVC', String(postData.iCVC));
                                            await page.type('#month', String(postData.month));
                                            await page.type('#year', String(postData.year));
                                            await page.type('#iTEXT', String(postData.iTEXT));

                                            await page.click('#buttonPayment', { waitUntil: 'networkidle2' });

                                            // Step 2: Authentification
                                            try {
                                                await page.waitForSelector('#paymentDataTable', { timeout: timeout });

                                                otpUrl = page.url();

                                                await page.waitForSelector('#sendPasswordButton', { timeout: timeout });
                                                await page.click('#sendPasswordButton', { waitUntil: 'networkidle2' });

                                                if (!!browser) await browser.close();

                                                response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 1, error: 0, status: 200, url: otpUrl }));
                                            } catch (error) {
                                                if (!!browser) await browser.close();

                                                response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                                            }
                                        }

                                    } catch (error) {

                                        if (!!browser) await browser.close();

                                        if (error instanceof Zod.ZodError) {
                                            response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 422, messages: error.issues }));
                                        } else {
                                            response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                                        }
                                    }

                                    break;
                                }
                            }

                            break;
                        }
                    }
                } catch (error) {

                    if (!!browser) await browser.close();

                    if (error instanceof Zod.ZodError) {
                        response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 422, messages: error.issues }));
                    } else {
                        response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 500, message: error.toString() }));
                    }
                }
            });
        } else {
            response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: 0, error: 1, status: 403, message: `403 Forbidden` }));
        }
    }
});

// Have the server listen on port
server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});