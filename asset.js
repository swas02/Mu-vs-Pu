// Xu moves in y-direction


fck = 25
Est = 2 * Math.pow(10, 5)
dataPoints = 500
// Linear Strain Compatibility In Column
// Documentation 
// function  linearStrainCompatibilityInColumn: (d: number, Xu: number, x: number) => number

const linearStrainCompatibilityInColumn = (d, Xu, x) => {
    // Here 'd' is the depth of cross section.
    // 'Xu' is the depth of neutral axis
    // 'x' is the depth where strain is to be 
    let εx

    // Check for empty, null, or undefined values
    if (d === undefined || d === null || Xu === undefined || Xu === null || x === undefined || x === null) {
        throw new Error("Values cannot be empty, null or undefined.");
    }

    // Check for non-numeric values (using isNaN for efficiency)
    if (isNaN(d) || isNaN(Xu) || isNaN(x)) {
        throw new Error("All input values (d, Xu, x) must be numbers.");
    }

    // Check for negative values (if applicable to your specific requirements)
    if (d < 0 || Xu < 0 || x < 0) {
        throw new Error("Values of d, Xu and x cannot be negative.");
    }

    // Check for d being greater than zero (if applicable)
    if (d <= 0) {
        throw new Error("d should be greater than zero.");
    }

    // Continue
    if (Xu <= d) {
        εx = 0.0035 * (1 - (x / Xu))
        return εx
    }
    else if (Xu > d) {
        εx = 0.002 * (Xu - x) / (Xu - (3 / 7) * d);
        return εx
    } else
        throw Error('Unknown Error is encountered')
}

const stressInConcreteAtStrain = (x) => {
    let ε = x

    if (ε >= 0 && ε <= 0.002)
        return 0.45 * fck * (2 * (ε / 0.002) - Math.pow((ε / 0.002), 2)) //
    else if (ε > 0.002 && ε <= 0.0035)
        return 0.45 * fck //
    else
        return 0
}

Math.interpolate = function (s1, s2, ε1, ε2, ε) {
    return s1 - (s1 - s2) * (ε1 - ε) / (ε1 - ε2);
}
const stressInFe415AtStrain = (x) => {
    let sign = 1
    if (x < 0) { sign = -1 }
    let ε = Math.abs(x)
    const stress = () => {
        if (ε >= 0 && ε < 0.00144)
            return Est * ε
        else if (ε >= 0.00144 && ε < 0.00163) {
            return Math.interpolate(288.7, 306.7, 0.00144, 0.00163, ε)
        }
        else if (ε >= 0.00163 && ε < 0.00192) {
            return Math.interpolate(306.7, 324.8, 0.00163, 0.00192, ε)
        }
        else if (ε >= 0.00192 && ε < 0.00241) {
            return Math.interpolate(324.8, 342.8, 0.00192, 0.00241, ε)
        }
        else if (ε >= 0.00241 && ε < 0.00276) {
            return Math.interpolate(342.8, 351.8, 0.00241, 0.00276, ε)
        }
        else if (ε >= 0.00276 && ε <= (0.002 + 0.87 * 415 / Est)) {
            return Math.interpolate(351.8, 360.9, 0.00276, 0.00380, ε)
        }
        else {
            // console.log('Strain exceeded: ', x)
            return 0
        }

    }
    return { ε: x, σ: sign * stress() }
}

const generateValuesModified = (start, end, equationFunction = 0, division = 500) => {
    if (equationFunction) {
        increment = (end - start) / division;
        xValues = [];
        yValues = [];
        for (let x = start; x <= end; x += increment) {
            xValues.push((x - start) / (end - start));
            yValues.push(equationFunction(x));
        }
        return [xValues, yValues]
    }

}


const concreteData = (εmin, εmax) => {
    let limit = 500

    arr = generateValuesModified(εmin, εmax, stressInConcreteAtStrain, limit)

    const xValues = arr[0];
    const yValues = arr[1];

    const n = xValues.length;
    const h = (xValues[n - 1] - xValues[0]) / (n - 1);

    let area = 0;
    let centroid = 0;

    //simpsons formula
    for (let i = 1; i < n - 1; i++) {
        const coefficient = i % 2 === 0 ? 2 : 4;
        area += coefficient * yValues[i];
        centroid += coefficient * xValues[i] * yValues[i];
    }

    area += yValues[0] + yValues[n - 1];
    centroid += xValues[0] * yValues[0] + xValues[n - 1] * yValues[n - 1];

    area *= h / 3;
    centroid *= h / 3 / area;
    // if (area > stressInConcreteAtStrain(0.0035) / 1.1)
    //     area = stressInConcreteAtStrain(0.0035) / 1.1 // minimum eccentricity
    let res = {
        εmin: εmin,
        εmax: εmax,
        σc: area,
        xXu: 1 - centroid,
    }
    return res;
}





/////////////////////////////////////////////////////////////////////////////////



function init(Xu) {
    let data = []
    CFs = 0
    MORs = 0
    circles.forEach((e) => {
        let strain = linearStrainCompatibilityInColumn(maxY, Xu, e.y)
        let ast = (Math.PI / 4) * Math.pow(e.dia, 2)
        let stressInConc = stressInConcreteAtStrain(strain)
        let stressInSteel = stressInFe415AtStrain(strain).σ
        let forceInConc = stressInConc * ast
        let forceInSteel = stressInSteel * ast
        let reducedForce = forceInSteel - forceInConc
        let leverArm = ((maxY / 2) - e.y)
        let MorOfSteel = forceInSteel * leverArm
        let MorOfConc = forceInConc * leverArm
        let reducedMOR = MorOfSteel - MorOfConc
        CFs += reducedForce
        MORs += reducedMOR
        data.push({ Xu, x: e.x, y: e.y, strain, ast, stressInConc, forceInConc, stressInSteel, forceInSteel, reducedForce, MorOfSteel, MorOfConc, reducedMOR, leverArm })
    })
    // console.table(data)

    minStrainInConc = linearStrainCompatibilityInColumn(maxY, Xu, Math.min(Xu, maxY))
    maxStrainInConc = linearStrainCompatibilityInColumn(maxY, Xu, 0)
    output = concreteData(minStrainInConc, maxStrainInConc)

    CFc = output.σc * maxX * Math.min(Xu, maxY)
    MORc = output.σc * maxX * Math.min(Xu, maxY) * (maxY / 2 - output.xXu * Math.min(Xu, maxY))
    CF = (CFc + CFs) * Math.pow(10, -3)
    MOR = (MORc + MORs) * Math.pow(10, -6)
    // console.log({ CF, MOR, output })
    return { Xu, CF, MOR, output, data }
}
function arrayToTable(data) {
    let table = document.createElement('table');
    let thead = document.createElement('thead');
    let tbody = document.createElement('tbody');

    if (data.length === 0) {
        console.error('Array is empty');
        return;
    }

    // Create table header row with column names from the first object in the array
    let headerRow = thead.insertRow();
    Object.keys(data[0]).forEach(key => {
        let th = document.createElement('th');
        th.textContent = key;
        headerRow.appendChild(th);
    });

    // Create table body rows with data from each object in the array
    data.forEach(obj => {
        let row = tbody.insertRow();
        Object.values(obj).forEach(value => {
            let cell = row.insertCell();
            cell.textContent = value;
        });
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    return table
}

function run() {
    let Mu = [], Pu = [], md = [];
    for (let index = 4 * maxY; index >= 0; index -= (4 * maxY / dataPoints)) {
        XuNew = Math.round(index * 1000) / 1000
        a = init(XuNew)
        // if(!isNaN(a.MOR)&&!isNaN(a.CF)){
        // if (a.MOR < 0) console.log(index)
        Mu.push(a.MOR)
        Pu.push(a.CF)
        md.push({ XuByD: Math.round(a.Xu * 1000 / maxY) / 1000, Pu: (a.CF).toFixed(3), Mu: (a.MOR).toFixed(3), e: (a.MOR * 1000 / a.CF).toFixed(3) })


        // a.data.forEach(e => (
        //     Mds.push(e)
        // ))

    }
    // console.log(md)
    // let newWindow = window.open()
    // newWindow.document.body.appendChild(arrayToTable(Mds, 'msd'))
    document.querySelector("#fullDetail").append(arrayToTable(md))

    let data = [{
        x: Mu,
        y: Pu,
        mode: "markers",
        type: "scatter",
        marker: {
            size: 4,
            // color: color // Set all points to red
        }
    }];

    // Define Layout
    const layout = {
        xaxis: { title: "Mu in kN-m" },
        yaxis: { title: "Pu in kN" },
        title: "Mu vs Pu"
    };

    // Display using Plotly
    Plotly.newPlot("myPlot", data, layout);

}