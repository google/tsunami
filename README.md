The TSUNAMI (TypeScript Untar Multiple Reads) library has two possible uses.
1. To extract from a tar file the names and contents (in ArrayBuffer format) of
files with a certain extension.
2. To extract only the names of the files within a tar archive, with the option
of excluding some file extensions from this list.

<hr>
An example of use case 1) would be the following:

```javascript
const tsunami = new Tsunami([/\.json/]);
await tsunami.untar(MyExampleFile);
const files = tsunami.files;

```
In this case, the files variable will hold an array of type UncompressedFile,
which is a format used to hold the name of a file and an ArrayBuffer of its
contents.

An example of use case 2) would be the following:

```javascript
// Passing true will prevent file contents from being read/returned
const tsunami = new Tsunami([/\.json/], true);
await tsunami.untar(MyExampleFile);
const fileNames = tsunami.files.map(f => f.name);
```

In this case, the fileNames variable will hold an array of strings which are
the names of the files within the tar archive.

The only input the class needs is a ustar format tar file.

***This is not an officially supported Google product.***

