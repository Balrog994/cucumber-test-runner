<h1 align="center">
    <img src="./docs/images/logo.png" alt="" />
    <br>
    CucumberJS Test Runner
</h1>

This extension integrates CucumberJS with Visual Studio Code Test Runner.

# Features

Semlessly integrates with Visual Studio Code new Test Runner showing all files in your workspace and a detailed view of all:

-   Features
-   Scenarios
-   Steps

![](./docs/images/testrunner.png)

## Test Result in `.feature` files

---

Now you can view which steps passed or failed directly in your `.feature` files, and with the help of the official Cucumber extension you can `ctrl+click` to navigate to your failing step.

![](./docs/images/feature.png)

## Inline error details

---

After running the test you will see an inline report of the failing tests with extensive details of the error and an history of test results.

![](./docs/images/inline-errors.png)

## Debug an entire feature or a single scenario

---

You can even debug your tests directly from the Test Runner UI, just click the `Debug Test` action on a Feature or a Scenario!

![](./docs/images/debug.png)

## New in version 0.5.0

---

### Search by @Tags

We support searching and filtering tests by @Tag (Thanks to psethwick)

![](./docs/images/tags.png)

### Override environment variables

Now you can specify environment variables in your `settings.json` file, so that when you run your tests those variables will be defined.

```json
{
    "cucumberTestRunner.env": {
        "MY_VARIABLE_1": "foo",
        "MY_VARIABLE_2": "bar"
    }
}
```

### Custom cucumber profile

Now you can select a profile to run the tests

```javascript
const common = {
    require: ["features/**/*.{js,ts}"],
    requireModule: ["ts-node/register"],
    publishQuiet: true,
};

module.exports = {
    default: {
        ...common,
        paths: ["features/**/*.feature"],
    },
    customProfile: {
        ...common,
    },
};
```

```json
{
    "cucumberTestRunner.profile": "customProfile"
}
```

### Better Error detection and reporting

Now the extension detects and reports errors in before and after hooks.
If possible it reports a problem directly at the line where the error occurred in the source file.
The support is still limited, stay tuned for the next updates.

# Prerequisites

You need to have a working `cucumber-js` installation in your working folder and a proper cucumber configuration file.
Please follow the documentation on the official `cucumber-js` website on how to setup the environment.

You need to install the `@cucumber/cucumber` npm package

```bash
npm install @cucumber/cucumber
```

For typescript support you need to install `ts-node`

```bash
npm install ts-node
```

# Compatibility

The extension has been tested with `javascript` and `typescript`.

Example of a `cucumber.yml` file for a `typescript` setup:

```yaml
default:
    features: ["features/**/*.feature"]
    requireModule: ["ts-node/register"]
    require: ["features/**/*.{js,ts}"]
    publishQuiet: true
```

# Known Issues

-   At the moment you cannot undefine an existing environment variable, the only thing you can do is set the variable to an empty string.
