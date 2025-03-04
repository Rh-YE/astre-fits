# Astre FITS - FITS File Viewer VSCode Extension

## Project Overview

Astre FITS (Astre comes from the French word for celestial body) is a VSCode extension specifically designed for viewing and analyzing FITS (Flexible Image Transport System) files, which also supports Cursor and Trae editors. It provides basic FITS file parsing and visualization capabilities (including image, spectrum plotting, and table display), allowing astronomers and researchers to conveniently view and analyze FITS file data directly in VSCode.

## Interface Features

When a user clicks on a FITS file, a window will automatically open to display the data within the FITS file. Users can freely switch between HDUs to display data. The current display is divided into three modes: image mode, spectrum mode, and table mode. This extension supports ImageHDU, BinTableHDU, and TableHDU (ASCII tables), but currently does not support spectrum and table data in PrimaryHDU.

When the FITS file contains extension HDUs, it will automatically open the data of the first extension HDU.

Image HDU integrates the following features:
- Mouse hover displays current position coordinates, WCS coordinates (if available), and original Pixel Value (though the displayed image is normalized to 0-1)
- Non-linear transformation
- FITS header information display

Spectrum HDU integrates the following features:
- Automatic/manual drawing of draggable and zoomable spectrum images
- Rectangle box selection for local magnification
- Hold Ctrl + scroll wheel to zoom X-axis
- Hold Shift + scroll wheel to zoom Y-axis
- Can select which column data to plot in the wavelength flux selection box
- Future support for mask and error plotting
- Can switch to display current table data
- FITS header information display

Table HDU integrates the following features:
- Table data display and table sorting

## Technical Implementation

### Core Modules

1. FITSParser
   - Responsible for low-level FITS file parsing
   - Implements complete FITS standard specifications
   - Supports parsing and conversion of multiple data formats

2. FITSViewerProvider
   - Provides VSCode custom editor support
   - Implements FITS file visualization
   - Handles user interaction and interface updates

3. Data Models
   - FITSHeader: Handles file header information
   - FITSHDU: Manages header data units
   - TableData: Processes table data
   - ColumnData: Manages column data

### Development Framework

- Based on VSCode Extension API
- Developed using TypeScript
- Adopts object-oriented design approach

## Limitations

1. Performance Limitations
   - Large files may load slowly, large images like HST wide-field images load slowly and are difficult to drag, limited by the web interface
   - Loading and parsing large FITS files may consume significant memory
   - Rendering complex table data may have performance bottlenecks
   - Limited by browser memory constraints

2. Data Compatibility
   - Some special FITS extension formats may not be supported
   - Complex compression formats may require additional processing
   - Some non-standard FITS files may not parse correctly
   - Special data formats may require additional parsers

## Future Improvement Plans

1. Performance Optimization
   - Implement data lazy loading
   - Optimize large file processing mechanisms
   - Improve memory usage efficiency

2. Feature Extensions
   - Add more data visualization options
   - Support more FITS file extension formats
   - Add data analysis tools

3. User Experience
   - Improve error notification mechanisms
   - Add more user configuration options
   - Optimize interface interaction design

## Development Requirements

- VSCode 1.97.0 or higher
- Node.js
- TypeScript

## Installation and Usage

1. Search for "Astre Fits" in VSCode Extension Marketplace
2. Click install
3. After installation, you can directly open .fits or .fit files
4. The extension will automatically activate and display file content

## Contribution Guidelines

Welcome to submit issue reports and feature suggestions to the project's GitHub repository. If you want to contribute code, please ensure:

1. Follow the project's code standards
2. Write necessary test cases
3. Submit detailed PR descriptions

## License

This project follows the MIT License.